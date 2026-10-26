import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { logger } from "@/logger";
import { getConfig } from "@/config";
import { getDatabase } from "@/storage";
import { PluginDefinition, PluginConfigEntry, LoadedPlugin, PluginHooks, PluginAPI, PluginLogger } from "./types";

const plugins: Map<string, LoadedPlugin> = new Map();
const cronJobs: Array<{ expression: string; handler: () => void | Promise<void> }> = [];
let initialized = false;

let discordClientProvider: () => any = () => null;
let telegramBotProvider: () => any = () => null;

export function setDiscordClientProvider(fn: () => any): void {
  discordClientProvider = fn;
}

export function setTelegramBotProvider(fn: () => any): void {
  telegramBotProvider = fn;
}

function createLogger(name: string): PluginLogger {
  const prefix = `[插件/${name}]`;
  return {
    info: (...args: any[]) => logger.info("Plugin", prefix, ...args),
    warn: (...args: any[]) => logger.warn("Plugin", prefix, ...args),
    error: (...args: any[]) => logger.error("Plugin", prefix, ...args),
  };
}

function getPluginConfig(name: string): PluginConfigEntry | undefined {
  const cfg = getConfig();
  return (cfg.plugins || []).find((p) => p.name === name);
}

export function getPluginAPI(name: string): PluginAPI {
  return {
    getConfig: () => getConfig(),
    registerCronJob: (expression: string, handler: () => void | Promise<void>) => {
      cronJobs.push({ expression, handler });
    },
    logger: createLogger(name),
    getDatabase: () => getDatabase(),
    getDiscordClient: () => discordClientProvider(),
    getTelegramBot: () => telegramBotProvider(),
  };
}

function resolveBuiltinDir(): string {
  return __dirname;
}

function resolveExternalDirs(): string[] {
  const cfg = getConfig();
  const d = cfg.pluginsDir;
  if (!d) return [];
  if (typeof d === "string") return [d];
  if (Array.isArray(d)) return d;
  return [];
}

async function loadPlugin(dirPath: string): Promise<LoadedPlugin | null> {
  const name = path.basename(dirPath);
  if (name.startsWith(".")) return null;

  const indexJs = path.join(dirPath, "index.js");
  const indexTs = path.join(dirPath, "index.ts");
  const entryPath = fs.existsSync(indexJs) ? indexJs : fs.existsSync(indexTs) ? indexTs : null;

  if (!entryPath) return null;

  try {
    const mod = await import(entryPath);
    const def = (mod.default || mod) as PluginDefinition;

    if (!def.manifest || !def.manifest.name) {
      logger.warn("Plugin", `跳过分目录 ${name}: 缺少 manifest.name`);
      return null;
    }

    return {
      manifest: def.manifest,
      hooks: def.hooks,
      init: def.init,
      config: getPluginConfig(def.manifest.name),
    };
  } catch (err) {
    logger.error("Plugin", `加载插件 ${name} 失败:`, err);
    return null;
  }
}

async function scanDir(scanPath: string): Promise<LoadedPlugin[]> {
  const results: LoadedPlugin[] = [];

  if (!fs.existsSync(scanPath)) return results;

  for (const entry of fs.readdirSync(scanPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const plugin = await loadPlugin(path.join(scanPath, entry.name));
      if (plugin) results.push(plugin);
    }
  }

  return results;
}

function ensureCacheDir(): string {
  const cacheDir = path.join(process.cwd(), "data", "plugins-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function parseGithubRepo(repo: string): { owner: string; repo: string } | null {
  const match = repo.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

async function syncGithubPlugin(entry: PluginConfigEntry): Promise<string | null> {
  if (!entry.github) return null;

  const parsed = parseGithubRepo(entry.github);
  if (!parsed) {
    logger.error("Plugin", `无效的 GitHub 仓库格式: ${entry.github} (应为 owner/repo)`);
    return null;
  }

  const cacheDir = ensureCacheDir();
  const targetDir = path.join(cacheDir, entry.name);
  const ref = entry.ref || "main";
  const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;

  try {
    if (fs.existsSync(targetDir)) {
      logger.info("Plugin", `更新 GitHub 插件 ${entry.name} (${cloneUrl}#${ref})...`);
      execSync(`git -C ${targetDir} fetch origin ${ref} --depth 1`, { stdio: "pipe" });
      execSync(`git -C ${targetDir} reset --hard FETCH_HEAD`, { stdio: "pipe" });
    } else {
      logger.info("Plugin", `克隆 GitHub 插件 ${entry.name} (${cloneUrl}#${ref})...`);
      execSync(`git clone ${cloneUrl} ${targetDir} --branch ${ref} --depth 1`, { stdio: "pipe" });
    }
    return targetDir;
  } catch (err) {
    logger.error("Plugin", `同步 GitHub 插件 ${entry.name} 失败:`, (err as Error).message);
    return null;
  }
}

async function discoverPlugins(): Promise<LoadedPlugin[]> {
  const results: LoadedPlugin[] = [];

  // 1. Scan built-in plugins (dist/plugins/ or src/plugins/)
  const builtin = await scanDir(resolveBuiltinDir());
  results.push(...builtin);

  // 2. Clone/pull GitHub-sourced plugins
  const configEntries = getConfig().plugins || [];
  for (const entry of configEntries) {
    if (entry.enabled === false) continue;
    if (!entry.github) continue;
    const pluginDir = await syncGithubPlugin(entry);
    if (pluginDir) {
      const plugin = await loadPlugin(pluginDir);
      if (plugin) results.push(plugin);
    }
  }

  // 3. Scan external plugin directories from config
  for (const extDir of resolveExternalDirs()) {
    const external = await scanDir(extDir);
    for (const plugin of external) {
      if (!results.some((p) => p.manifest.name === plugin.manifest.name)) {
        results.push(plugin);
      }
    }
  }

  return results;
}

export async function loadPlugins(): Promise<void> {
  if (initialized) return;

  const discovered = await discoverPlugins();
  let loaded = 0;

  for (const plugin of discovered) {
    const config = plugin.config;
    if (config && !config.enabled) {
      logger.info("Plugin", `插件 ${plugin.manifest.name} 已禁用，跳过`);
      continue;
    }

    plugins.set(plugin.manifest.name, plugin);

    if (plugin.init) {
      try {
        await plugin.init(getPluginAPI(plugin.manifest.name));
      } catch (err) {
        logger.error("Plugin", `插件 ${plugin.manifest.name} init 失败:`, err);
      }
    }

    loaded++;
  }

  if (loaded > 0) {
    logger.info("Plugin", `已加载 ${loaded} 个插件 (来源: 内置 + ${resolveExternalDirs().length} 个外部目录)`);
  }

  initialized = true;
}

export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(plugins.values());
}

export function getPlugin(name: string): LoadedPlugin | undefined {
  return plugins.get(name);
}

export function getPluginCronJobs(): Array<{ expression: string; handler: () => void | Promise<void> }> {
  return [...cronJobs];
}

async function callHook<T>(
  hookName: string,
  fns: Array<(...args: any[]) => T | Promise<T>>,
  ...args: any[]
): Promise<void> {
  for (const fn of fns) {
    try {
      await fn(...args);
    } catch (err) {
      logger.error("Plugin", `钩子 ${hookName} 执行失败:`, err);
    }
  }
}

function collectHooks<K extends keyof PluginHooks>(key: K): Array<NonNullable<PluginHooks[K]>> {
  const hooks: Array<NonNullable<PluginHooks[K]>> = [];
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks[key];
    if (hook) hooks.push(hook as any);
  }
  return hooks;
}

export async function executeHook<K extends keyof PluginHooks>(
  key: K,
  ...args: Parameters<NonNullable<PluginHooks[K]>>
): Promise<void> {
  const hooks = collectHooks(key);
  if (hooks.length === 0) return;
  await callHook(key as string, hooks as any, ...args);
}

export async function executeTweetHook(tweet: any): Promise<any> {
  let current = tweet;
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onTweetReceived as ((tweet: any) => any | Promise<any>) | undefined;
    if (!hook) continue;
    try {
      const result = await hook(current);
      if (result === null) return null;
      if (result !== undefined) current = result;
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onTweetReceived 失败:`, err);
    }
  }
  return current;
}

export async function executeBeforeSendHook(tweet: any, group: any): Promise<any> {
  let current = tweet;
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onBeforeTweetSend as ((tweet: any, group: any) => any | Promise<any>) | undefined;
    if (!hook) continue;
    try {
      const result = await hook(current, group);
      if (result === null) return null;
      if (result !== undefined) current = result;
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onBeforeTweetSend 失败:`, err);
    }
  }
  return current;
}

export async function executeDiscordMessageHook(message: any): Promise<boolean> {
  let claimed = false;
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onDiscordMessage;
    if (!hook) continue;
    try {
      const result = await hook(message);
      if (result === true) claimed = true;
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onDiscordMessage 失败:`, err);
    }
  }
  return claimed;
}

export async function executeTelegramMessageHook(ctx: any): Promise<boolean> {
  let claimed = false;
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onTelegramMessage;
    if (!hook) continue;
    try {
      const result = await hook(ctx);
      if (result === true) claimed = true;
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onTelegramMessage 失败:`, err);
    }
  }
  return claimed;
}

export async function executeOneBotMessageHook(message: any): Promise<boolean> {
  let claimed = false;
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onOneBotMessage;
    if (!hook) continue;
    try {
      const result = await hook(message);
      if (result === true) claimed = true;
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onOneBotMessage 失败:`, err);
    }
  }
  return claimed;
}

export async function executeBeforeApprovalHook(tweet: any, group: any): Promise<any> {
  let current = tweet;
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onBeforeApproval as ((tweet: any, group: any) => any | Promise<any>) | undefined;
    if (!hook) continue;
    try {
      const result = await hook(current, group);
      if (result === null) return null;
      if (result !== undefined) current = result;
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onBeforeApproval 失败:`, err);
    }
  }
  return current;
}

export async function getPluginDiscordCommands(): Promise<any[]> {
  const commands: any[] = [];
  for (const plugin of plugins.values()) {
    const hook = plugin.hooks.onDiscordCommands as (() => any[] | Promise<any[]>) | undefined;
    if (!hook) continue;
    try {
      const result = await hook();
      if (Array.isArray(result)) {
        commands.push(...result);
      }
    } catch (err) {
      logger.error("Plugin", `插件 ${plugin.manifest.name} onDiscordCommands 失败:`, err);
    }
  }
  return commands;
}

export async function shutdownPlugins(): Promise<void> {
  await executeHook("onBeforeShutdown");
  plugins.clear();
  cronJobs.length = 0;
  initialized = false;
  logger.info("Plugin", "所有插件已关闭");
}
