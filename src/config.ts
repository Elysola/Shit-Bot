import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { AIConfig, AppConfig, DiscordConfig, GroupConfig, PrivilegedIntentMode, VectorBackendMode } from './types';

/** 把配置里的数值安全转成 [min,max] 内的有限整数；非法(NaN/负数/超大/非数字)时回退默认值。
 *  防止坏配置(尤其经 WebUI 保存)把 SQLite LIMIT 变成负数=无限读、或让工具循环/各类上限失控。 */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function clampFloat(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(n, max));
}

function obj(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

/** 原样保留字符串（不 trim）：前缀类配置可能有意带尾随空格/换行 */
function str(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def;
}

/** 去掉首尾空白；空串回退默认值。用于 URL、模型名、ID 这类值 */
function trimmed(v: unknown, def: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : def;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function strRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) {
    if (typeof val === 'string' && val.trim()) out[String(k)] = val.trim();
  }
  return out;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

/** "HH:MM-HH:MM"（UTC+8）；格式不对视为未设置 */
function quietHours(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

const INTENT_MODES: readonly PrivilegedIntentMode[] = ['auto', 'on', 'off'];
const VECTOR_BACKENDS: readonly VectorBackendMode[] = ['auto', 'sqlite', 'js'];

/**
 * 把原始 ai 配置规范化为完整的 AIConfig：补默认值、数值钳到合法区间、合并环境变量。
 * 对已规范化的对象再调用一次结果不变（幂等），WebUI 保存后会再跑一遍，防止半截嵌套对象覆盖掉默认值。
 */
export function normalizeAiConfig(rawAi: unknown): AIConfig {
  const ai = obj(rawAi);
  const mem = obj(ai.memory);
  const observe = obj(mem.observe);
  const extractor = obj(mem.extractor);
  const core = obj(mem.core);
  const context = obj(mem.context);
  const persona = obj(ai.persona);
  const history = obj(ai.history);
  const embedding = obj(ai.embedding);
  const vector = obj(ai.vector);
  const affinity = obj(ai.affinity);
  const affinityDecay = obj(affinity.decay);
  const mood = obj(ai.mood);
  const proactive = obj(ai.proactive);

  return {
    enabled: ai.enabled ?? false,
    apiUrl: process.env.AI_API_URL || ai.apiUrl || 'https://api.openai.com/v1',
    apiKey: process.env.AI_API_KEY || ai.apiKey || '',
    model: ai.model || 'gpt-3.5-turbo',
    systemPrompt: ai.systemPrompt || '你是一个有帮助的助手。',
    maxTokens: clampInt(ai.maxTokens, 1024, 1, 32768),
    temperature: clampFloat(ai.temperature, 0.7, 0, 2),
    allowedGuildIds: ai.allowedGuildIds ?? [],
    maxToolIterations: clampInt(ai.maxToolIterations, 12, 1, 30),
    reactions: ai.reactions ?? true,
    // 图片改由本机下载后以 base64 内联发给网关，故需限制单图与单次请求的字节量
    maxImageBytes: clampInt(ai.maxImageBytes, 6 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    maxTotalImageBytes: clampInt(ai.maxTotalImageBytes, 12 * 1024 * 1024, 256 * 1024, 40 * 1024 * 1024),
    webSearch: {
      enabled: ai.webSearch?.enabled ?? false,
      provider: ai.webSearch?.provider || 'duckduckgo',
      apiKey: process.env.AI_WEB_SEARCH_API_KEY || ai.webSearch?.apiKey || '',
      baseUrl: ai.webSearch?.baseUrl || '',
      maxResults: clampInt(ai.webSearch?.maxResults, 5, 1, 10),
    },
    memory: {
      enabled: mem.enabled ?? false,
      maxProfileItems: clampInt(mem.maxProfileItems, 12, 1, 200),
      maxProfileChars: clampInt(mem.maxProfileChars, 800, 50, 20000),
      recentTurns: clampInt(mem.recentTurns, 6, 0, 100),
      recallLimit: clampInt(mem.recallLimit, 8, 1, 100),
      logConversations: mem.logConversations ?? true,
      maxConversationsPerUser: clampInt(mem.maxConversationsPerUser, 500, 1, 100000),
      observe: {
        enabled: bool(observe.enabled, true),
        channelDenylist: strList(observe.channelDenylist),
        retentionDays: clampInt(observe.retentionDays, 0, 0, 36500),
        crossGuildMessages: bool(observe.crossGuildMessages, false),
      },
      extractor: {
        model: trimmed(extractor.model, ''),
        apiUrl: trimmed(extractor.apiUrl, ''),
        apiKey: process.env.AI_EXTRACTOR_API_KEY || trimmed(extractor.apiKey, ''),
        windowMessages: clampInt(extractor.windowMessages, 40, 5, 200),
        idleSeconds: clampInt(extractor.idleSeconds, 180, 10, 3600),
        maxWaitMinutes: clampInt(extractor.maxWaitMinutes, 30, 1, 1440),
        images: bool(extractor.images, true),
        maxImagesPerWindow: clampInt(extractor.maxImagesPerWindow, 4, 0, 10),
        concurrency: clampInt(extractor.concurrency, 1, 1, 4),
        dailyTokenBudget: clampInt(extractor.dailyTokenBudget, 3_000_000, 0, 1_000_000_000),
      },
      core: {
        userPins: clampInt(core.userPins, 12, 0, 50),
        guildPins: clampInt(core.guildPins, 20, 0, 100),
        selfPins: clampInt(core.selfPins, 10, 0, 50),
        autoPinImportance: clampInt(core.autoPinImportance, 8, 1, 11),
        upcomingDays: clampInt(core.upcomingDays, 7, 0, 60),
      },
      context: {
        speakerChars: clampInt(context.speakerChars, 1200, 200, 20000),
        mentionedChars: clampInt(context.mentionedChars, 500, 100, 10000),
        mentionedUsers: clampInt(context.mentionedUsers, 3, 0, 10),
        guildChars: clampInt(context.guildChars, 1000, 0, 20000),
        selfChars: clampInt(context.selfChars, 600, 0, 10000),
        loreChars: clampInt(context.loreChars, 1000, 0, 20000),
        recentChannelMessages: clampInt(context.recentChannelMessages, 15, 0, 200),
        recentChannelChars: clampInt(context.recentChannelChars, 2000, 0, 50000),
        autoRecall: clampInt(context.autoRecall, 0, 0, 30),
      },
      tools: {
        maxResultChars: clampInt(obj(mem.tools).maxResultChars, 30000, 2000, 200000),
      },
    },
    summary: {
      enabled: ai.summary?.enabled ?? false,
      maxMessagesPerChannel: clampInt(ai.summary?.maxMessagesPerChannel, 500, 1, 100000),
      defaultCount: clampInt(ai.summary?.defaultCount, 100, 1, 100000),
    },
    persona: {
      dir: trimmed(persona.dir, 'data/personas'),
      default: trimmed(persona.default, 'memecat'),
      guilds: strRecord(persona.guilds),
    },
    lore: { dir: trimmed(obj(ai.lore).dir, 'data/lore') },
    history: {
      gapFillOnStartup: bool(history.gapFillOnStartup, true),
      initialDays: clampInt(history.initialDays, 30, 0, 3650),
      maxMessagesPerChannel: clampInt(history.maxMessagesPerChannel, 5000, 0, 1_000_000),
      includeThreads: bool(history.includeThreads, true),
      archivedThreadDays: clampInt(history.archivedThreadDays, 30, 0, 3650),
      requestIntervalMs: clampInt(history.requestIntervalMs, 350, 0, 10000),
    },
    embedding: {
      apiUrl: trimmed(embedding.apiUrl, ''),
      apiKey: process.env.AI_EMBEDDING_API_KEY || trimmed(embedding.apiKey, ''),
      model: trimmed(embedding.model, ''),
      dimensions: clampInt(embedding.dimensions, 0, 0, 8192),
      batchSize: clampInt(embedding.batchSize, 32, 1, 256),
      timeoutMs: clampInt(embedding.timeoutMs, 8000, 1000, 120000),
      queryPrefix: str(embedding.queryPrefix, ''),
      documentPrefix: str(embedding.documentPrefix, ''),
    },
    vector: {
      backend: oneOf(vector.backend, VECTOR_BACKENDS, 'auto'),
      extensionPath: trimmed(vector.extensionPath, ''),
      customSqlitePath: trimmed(vector.customSqlitePath, ''),
      exactThreshold: clampInt(vector.exactThreshold, 3000, 100, 1_000_000),
      coarseK: clampInt(vector.coarseK, 200, 10, 5000),
    },
    affinity: {
      enabled: bool(affinity.enabled, true),
      maxGainPerInteraction: clampInt(affinity.maxGainPerInteraction, 5, 0, 100),
      maxLossPerInteraction: clampInt(affinity.maxLossPerInteraction, 8, 0, 100),
      dailyGainCap: clampInt(affinity.dailyGainCap, 15, 0, 200),
      dailyLossCap: clampInt(affinity.dailyLossCap, 30, 0, 200),
      decay: {
        enabled: bool(affinityDecay.enabled, true),
        afterDays: clampInt(affinityDecay.afterDays, 14, 1, 3650),
        pointsPerWeek: clampInt(affinityDecay.pointsPerWeek, 1, 0, 100),
      },
    },
    mood: {
      enabled: bool(mood.enabled, true),
      valenceHalfLifeHours: clampFloat(mood.valenceHalfLifeHours, 3, 0.1, 168),
      arousalHalfLifeHours: clampFloat(mood.arousalHalfLifeHours, 1, 0.1, 168),
      maxUserImpactPerHour: clampFloat(mood.maxUserImpactPerHour, 0.5, 0, 2),
    },
    proactive: {
      enabled: bool(proactive.enabled, true),
      channels: strList(proactive.channels),
      denyChannels: strList(proactive.denyChannels),
      threshold: clampFloat(proactive.threshold, 0.35, 0, 10),
      debounceSeconds: clampInt(proactive.debounceSeconds, 25, 1, 600),
      forceEvalEveryMessages: clampInt(proactive.forceEvalEveryMessages, 20, 2, 500),
      cooldownMinutes: clampInt(proactive.cooldownMinutes, 10, 0, 1440),
      aliasCooldownSeconds: clampInt(proactive.aliasCooldownSeconds, 60, 0, 3600),
      maxPerHourPerChannel: clampInt(proactive.maxPerHourPerChannel, 3, 0, 60),
      maxPerDay: clampInt(proactive.maxPerDay, 40, 0, 10000),
      maxJudgeCallsPerDay: clampInt(proactive.maxJudgeCallsPerDay, 400, 0, 100000),
      quietHours: quietHours(proactive.quietHours),
      allowReactOnly: bool(proactive.allowReactOnly, true),
      judgeModel: trimmed(proactive.judgeModel, ''),
    },
  };
}

// 旧版 KV 记忆的配置项：新的分层记忆不再使用（只在加载配置时提示一次）
const DEPRECATED_MEMORY_KEYS: Record<string, string> = {
  maxProfileItems: 'ai.memory.core.userPins（置顶条数）',
  maxProfileChars: 'ai.memory.context.speakerChars（说话人档案字数）',
  recentTurns: 'ai.memory.context.recentChannelMessages（频道最近消息条数）',
  recallLimit: 'search_memory 的 limit 参数（由模型按需指定）',
  logConversations: 'ai.memory.observe.enabled（所有消息统一入库）',
  maxConversationsPerUser: 'ai.memory.observe.retentionDays（原始消息保留天数）',
};

function warnDeprecatedAiKeys(rawAi: unknown): void {
  const mem = obj(obj(rawAi).memory);
  for (const [key, replacement] of Object.entries(DEPRECATED_MEMORY_KEYS)) {
    if (key in mem) console.warn(`[配置] ai.memory.${key} 已废弃，不再生效；对应的新配置：${replacement}`);
  }
}

export function normalizePrivilegedIntents(raw: unknown): DiscordConfig['privilegedIntents'] {
  const p = obj(raw);
  return {
    members: oneOf(p.members, INTENT_MODES, 'auto'),
    presences: oneOf(p.presences, INTENT_MODES, 'auto'),
  };
}

const CONFIG_CANDIDATES = [
  'config.yaml',
  'config.yml',
  'config.toml',
  'config.json',
];

function resolveBaseDir(): string {
  const cwd = process.cwd();
  for (const candidate of CONFIG_CANDIDATES) {
    if (fs.existsSync(path.join(cwd, candidate))) return cwd;
  }
  return path.join(__dirname, '..');
}

dotenv.config();

const BASE_DIR = resolveBaseDir();

let config: AppConfig | null = null;
let loadedConfigPath: string | null = null;
let rawConfigData: Record<string, any> | null = null;

const DATA_CONFIG_CANDIDATES = [
  'data/config.yaml',
  'data/config.yml',
  'data/config.toml',
  'data/config.json',
];

export function findConfigFile(): string {
  for (const candidate of DATA_CONFIG_CANDIDATES) {
    const fullPath = path.join(BASE_DIR, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = path.join(BASE_DIR, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  throw new Error(
    `找不到配置文件。支持的格式: ${CONFIG_CANDIDATES.join(', ')}`
  );
}

function parseConfigFile(filePath: string): Record<string, any> {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  switch (ext) {
    case '.yaml':
    case '.yml':
      return parseYaml(content) as Record<string, any>;
    case '.toml':
      return parseToml(content);
    case '.json':
      return JSON.parse(content);
    default:
      throw new Error(`不支持的配置格式: ${ext}`);
  }
}

export function loadConfig(configPath?: string): AppConfig {
  if (config) {
    return config;
  }

  const filePath = configPath || findConfigFile();
  rawConfigData = parseConfigFile(filePath);
  loadedConfigPath = filePath;

  const loadedConfig = buildConfig(rawConfigData);
  warnDeprecatedAiKeys(rawConfigData.ai);

  validateConfig(loadedConfig);
  config = loadedConfig;
  console.log(`配置已从 ${filePath} 加载`);
  return config;
}

/** 测试专用：用给定的原始配置直接构造并替换当前配置（不读文件、不做 validateConfig 的强校验）。 */
export function setConfigForTesting(raw: Record<string, any>): AppConfig {
  rawConfigData = raw;
  loadedConfigPath = null;
  config = buildConfig(raw);
  return config;
}

function buildConfig(rawConfig: Record<string, any>): AppConfig {
  return {
    ...rawConfig,
    discord: {
      ...rawConfig.discord,
      token: process.env.DISCORD_TOKEN || rawConfig.discord?.token,
      privilegedIntents: normalizePrivilegedIntents(rawConfig.discord?.privilegedIntents),
    },
    telegram: {
      ...rawConfig.telegram,
      token: process.env.TELEGRAM_TOKEN || rawConfig.telegram?.token,
    },
    twitter: {
      enabled: rawConfig.twitter?.enabled ?? true,
      authToken: process.env.TWITTER_AUTH_TOKEN || rawConfig.twitter?.authToken || '',
      ct0: process.env.TWITTER_CT0 || rawConfig.twitter?.ct0 || '',
      username: process.env.TWITTER_USERNAME || rawConfig.twitter?.username,
      password: process.env.TWITTER_PASSWORD || rawConfig.twitter?.password,
      email: process.env.TWITTER_EMAIL || rawConfig.twitter?.email,
      totpSecret: process.env.TWITTER_TOTP_SECRET || rawConfig.twitter?.totpSecret,
    },
    ai: normalizeAiConfig(rawConfig.ai),
    webui: {
      enabled: rawConfig.webui?.enabled ?? true,
      port: rawConfig.webui?.port ?? 3000,
      host: rawConfig.webui?.host ?? '0.0.0.0',
      password: rawConfig.webui?.password ?? '',
    },
    xToImageApiUrl: process.env.X_TO_IMAGE_API_URL || rawConfig.xToImageApiUrl,
    xToImageApiToken: process.env.X_TO_IMAGE_API_TOKEN || rawConfig.xToImageApiToken,
    xToImageApiTheme: process.env.X_TO_IMAGE_API_THEME as 'light' | 'dim' | 'dark' | undefined || rawConfig.xToImageApiTheme,
  } as AppConfig;
}

function validateConfig(cfg: AppConfig): void {
  const twitterEnabled = cfg.twitter.enabled !== false;

  if (!cfg.groups || cfg.groups.length === 0) {
    if (twitterEnabled) {
      throw new Error('未配置群组, 至少需要一个包含用户的群组。');
    }
  } else {
    let hasAnyUser = false;
    const names = new Set<string>();

    for (const g of cfg.groups) {
      if (!g.name) {
        throw new Error('每个群组必须有名称');
      }
      if (names.has(g.name)) {
        throw new Error(`群组名称重复: ${g.name}`);
      }
      names.add(g.name);

      if (g.users && g.users.length > 0) {
        hasAnyUser = true;
      }

      if (g.telegram && !g.telegram.chatId) {
        throw new Error(`Group "${g.name}" has telegram config but no chatId`);
      }
      if (g.discord && !g.discord.channelId) {
        throw new Error(`Group "${g.name}" has discord config but no channelId`);
      }
    }

    if (twitterEnabled && !hasAnyUser) {
      throw new Error('At least one group must have users configured');
    }

    const hasWildcardGroup = cfg.groups.some(g => g.users?.some(u => u.username === '*'));
    const hasDefaultUsers = (cfg.users || []).length > 0;
    if (twitterEnabled && hasWildcardGroup && !hasDefaultUsers) {
      throw new Error('Groups use wildcard "*" but no top-level users are configured');
    }
  }

  if (cfg.discord.enabled) {
    if (!cfg.discord.token) {
      throw new Error('Discord is enabled but token is missing');
    }
  }

  if (cfg.telegram.enabled) {
    if (!cfg.telegram.token) {
      throw new Error('Telegram is enabled but token is missing');
    }
  }

  const hasCookies = cfg.twitter.authToken && cfg.twitter.ct0;
  const hasLogin = cfg.twitter.username && cfg.twitter.password;

  if (!hasCookies && !hasLogin) {
    console.warn('未配置 Twitter 认证, 将使用访客模式 (速率和访问受限)');
  }

  if (!cfg.pollIntervalMinutes || cfg.pollIntervalMinutes < 1) {
    cfg.pollIntervalMinutes = 5;
  }

  if (!cfg.maxPostsPerFetch || cfg.maxPostsPerFetch < 1) {
    cfg.maxPostsPerFetch = 20;
  }

  if (!cfg.maxTweetAgeMinutes || cfg.maxTweetAgeMinutes < 1) {
    cfg.maxTweetAgeMinutes = 60;
  }

  if (!cfg.imageCacheTtlMinutes || cfg.imageCacheTtlMinutes < 1) {
    cfg.imageCacheTtlMinutes = 60;
  }

  if (cfg.ai.enabled) {
    if (!cfg.ai.apiKey) {
      console.warn('AI 聊天已启用但未配置 API Key，将禁用 AI 聊天');
      cfg.ai.enabled = false;
    }
    if (!cfg.ai.apiUrl) {
      cfg.ai.apiUrl = 'https://api.openai.com/v1';
    }
    if (!cfg.ai.model) {
      cfg.ai.model = 'gpt-3.5-turbo';
    }
  }

  if (cfg.enableApproval) {
    const hasGroupAdmins = cfg.groups?.some(g =>
      (g.telegram && g.approval?.telegramAdminChatIds?.length) ||
      (g.discord && g.approval?.discordAdminChannelId)
    );

    if (!hasGroupAdmins) {
      console.warn('审批模式已启用但未配置管理员, 正在禁用审批');
      cfg.enableApproval = false;
    }
  }
}

export function getConfig(): AppConfig {
  if (!config) {
    return loadConfig();
  }
  return config;
}

export function getEffectiveGroups(): GroupConfig[] {
  const cfg = getConfig();
  const defaultUsers = cfg.users || [];
  const groups = cfg.groups || [];
  return groups.map(g => {
    if (!g.users) return g;
    const hasWildcard = g.users.some(u => u.username === '*');
    if (!hasWildcard) return g;
    const filtered = g.users.filter(u => u.username !== '*');
    return { ...g, users: [...filtered, ...defaultUsers] };
  });
}

export function getAllMonitoredUsers(): Array<{ username: string; groups: string[] }> {
  const groups = getEffectiveGroups();
  const userMap = new Map<string, Set<string>>();

  for (const g of groups) {
    const users = g.users || [];
    for (const u of users) {
      if (!userMap.has(u.username)) {
        userMap.set(u.username, new Set());
      }
      userMap.get(u.username)!.add(g.name);
    }
  }

  return Array.from(userMap.entries()).map(([username, groupSet]) => ({
    username,
    groups: Array.from(groupSet),
  }));
}

export function getGroupNamesForUser(username: string): string[] {
  const groups = getEffectiveGroups();
  const names: string[] = [];

  for (const g of groups) {
    const users = g.users || [];
    if (users.some(u => u.username === username)) {
      names.push(g.name);
    }
  }

  return names;
}

export function isUserInGroup(username: string, groupName: string): boolean {
  const group = getEffectiveGroups().find(g => g.name === groupName);
  if (!group) return false;
  const users = group.users || [];
  return users.some(u => u.username === username);
}

export function getConfigPath(): string | null {
  return loadedConfigPath;
}

export function saveConfig(newConfig: AppConfig): void {
  if (!loadedConfigPath || !rawConfigData) {
    throw new Error('没有加载配置文件');
  }

  rawConfigData.discord = newConfig.discord;
  rawConfigData.telegram = newConfig.telegram;
  rawConfigData.twitter = newConfig.twitter;
  rawConfigData.webui = newConfig.webui;
  rawConfigData.ai = newConfig.ai;
  rawConfigData.enableApproval = newConfig.enableApproval;
  rawConfigData.sendAsImage = newConfig.sendAsImage;
  rawConfigData.xToImageApiUrl = newConfig.xToImageApiUrl;
  rawConfigData.xToImageApiToken = newConfig.xToImageApiToken;
  rawConfigData.xToImageApiTheme = newConfig.xToImageApiTheme;
  rawConfigData.imageCacheTtlMinutes = newConfig.imageCacheTtlMinutes;
  rawConfigData.pollIntervalMinutes = newConfig.pollIntervalMinutes;
  rawConfigData.maxPostsPerFetch = newConfig.maxPostsPerFetch;
  rawConfigData.maxTweetAgeMinutes = newConfig.maxTweetAgeMinutes;
  rawConfigData.users = newConfig.users;
  rawConfigData.groups = newConfig.groups;

  const ext = path.extname(loadedConfigPath).toLowerCase();
  let content: string;

  switch (ext) {
    case '.yaml':
    case '.yml':
      content = stringifyYaml(rawConfigData);
      break;
    case '.json':
      content = JSON.stringify(rawConfigData, null, 2);
      break;
    default:
      throw new Error(`不支持的保存配置格式: ${ext}`);
  }

  try {
    fs.writeFileSync(loadedConfigPath, content, 'utf-8');
  } catch (err: any) {
    if (err.code === 'EROFS') {
      const fallback = path.join(BASE_DIR, DATA_CONFIG_CANDIDATES[0]);
      const fallbackDir = path.dirname(fallback);
      fs.mkdirSync(fallbackDir, { recursive: true });
      fs.writeFileSync(fallback, content, 'utf-8');
      loadedConfigPath = fallback;
      console.log(`配置文件只读, 已保存至 ${fallback}`);
    } else {
      throw err;
    }
  }

  config = newConfig;
  console.log(`配置已保存至 ${loadedConfigPath}`);
}

export function reloadConfig(): AppConfig {
  config = null;
  rawConfigData = null;
  loadedConfigPath = null;
  return loadConfig();
}
