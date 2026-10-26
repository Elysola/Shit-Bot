import type { PluginAPI, PluginDefinition } from "@/plugins/types";
import { isOneBotConnected } from "@/bots/onebot";
import { getJmDailyConfig, invalidateJmDailyConfigCache } from "./config";
import type { JmDailyOptions, JmDailySource } from "./config";
import { fetchAlbumSummary, fetchDailyAlbumIds } from "./jm";
import type { JmAlbumSummary } from "./jm";
import { sendDailyAlbums } from "./sender";
import type { ResolvedTargets } from "./sender";

const DB_TABLE = "jm_daily_sent";

// ===== 手动命令解析（/jm <source> [limit]） =====

const SOURCE_ALIASES: Record<string, JmDailySource> = {
  daily: "daily",
  day: "daily",
  日: "daily",
  日榜: "daily",
  week: "week",
  weekly: "week",
  周: "week",
  周榜: "week",
  month: "month",
  monthly: "month",
  月: "month",
  月榜: "month",
  popular: "popular",
  hot: "popular",
  人气: "popular",
  latest: "latest",
  new: "latest",
  最新: "latest",
};

export interface JmCommand {
  source: JmDailySource;
  limit: number;
}

export function parseJmCommand(text: string): JmCommand | null {
  const m = text.trim().match(/^\/jm\s+([a-z\u4e00-\u9fa5]+)(?:\s+(\d+))?\s*$/i);
  if (!m) return null;
  const source = SOURCE_ALIASES[m[1]!.toLowerCase()];
  if (!source) return null;
  const parsedLimit = m[2] ? parseInt(m[2]!, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 50)) : getJmDailyConfig().limit;
  return { source, limit };
}

let api: PluginAPI | null = null;
let running = false;

/** 解析发送目标：只使用插件配置的 targets（未配置则为空，不回退到 groups） */
function resolveTargets(cfg: JmDailyOptions): ResolvedTargets {
  const t = cfg.targets;
  return {
    telegram: [...(t?.telegram || [])],
    discord: [...(t?.discord || [])],
    onebot: [...(t?.onebot || [])],
  };
}

function hasTargets(targets: ResolvedTargets): boolean {
  return targets.telegram.length + targets.discord.length + targets.onebot.length > 0;
}

function ensureTable(): void {
  try {
    const db = api?.getDatabase();
    if (!db) return;
    db.run(`
      CREATE TABLE IF NOT EXISTS ${DB_TABLE} (
        album_id TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL
      )
    `);
  } catch (err) {
    api?.logger.error(`创建去重表失败: ${(err as Error)?.message}`);
  }
}

function isAlreadySent(albumId: string): boolean {
  try {
    const db = api?.getDatabase();
    if (!db) return false;
    const row = db.prepare(`SELECT 1 FROM ${DB_TABLE} WHERE album_id = ?`).get(albumId);
    return !!row;
  } catch (err) {
    api?.logger.error(`查询去重记录失败: ${(err as Error)?.message}`);
    return false;
  }
}

function markSent(albumId: string): void {
  try {
    const db = api?.getDatabase();
    if (!db) return;
    db.prepare(`INSERT OR IGNORE INTO ${DB_TABLE} (album_id, sent_at) VALUES (?, ?)`).run(albumId, Date.now());
  } catch (err) {
    api?.logger.error(`写入去重记录失败: ${(err as Error)?.message}`);
  }
}

function cleanupHistory(historyDays: number): void {
  try {
    const db = api?.getDatabase();
    if (!db) return;
    const cutoff = Date.now() - historyDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM ${DB_TABLE} WHERE sent_at < ?`).run(cutoff);
  } catch (err) {
    api?.logger.warn(`清理去重历史失败: ${(err as Error)?.message}`);
  }
}

/** 过滤掉命中 excludeTags 的本子 */
function filterExcluded(albums: JmAlbumSummary[], excludeTags: string[]): JmAlbumSummary[] {
  if (excludeTags.length === 0) return albums;
  return albums.filter((album) => !album.tags.some((tag) => excludeTags.includes(tag)));
}

/**
 * 拉取并收集本子详情，直到攒够 limit 本。
 * 被去重/详情失败/excludeTags 排除的本子会跳过，并继续往后拉取补足数量；
 * 详情逐个抓取，凑满 limit 立即停止，避免不必要的串行请求。
 */
async function collectTopAlbums(
  source: JmDailySource,
  limit: number,
  dedupe: boolean,
  excludeTags: string[],
): Promise<JmAlbumSummary[]> {
  const pluginApi = api;
  const albums: JmAlbumSummary[] = [];
  const fetched = new Set<string>();
  let windowSize = limit;

  for (let round = 1; round <= 10 && albums.length < limit; round++) {
    const ids = await fetchDailyAlbumIds(source, windowSize);
    if (ids.length === 0) break;

    const freshIds = ids.filter((id) => {
      if (fetched.has(id)) return false;
      fetched.add(id);
      return true;
    });
    if (freshIds.length === 0) break;

    pluginApi?.logger.info(
      `第 ${round} 批候选 ${freshIds.length} 本（窗口 ${windowSize}），当前已收集 ${albums.length}/${limit}`,
    );

    for (const id of freshIds) {
      if (albums.length >= limit) break;
      if (dedupe && isAlreadySent(id)) continue;
      try {
        const summary = await fetchAlbumSummary(id);
        if (summary && filterExcluded([summary], excludeTags).length) {
          albums.push(summary);
        }
      } catch (err) {
        pluginApi?.logger.warn(`获取 JM${id} 详情失败: ${(err as Error)?.message}`);
      }
    }

    windowSize = Math.min(windowSize + limit, 100);
  }

  return albums;
}

/** 发送并记录去重，返回成功发送数 */
async function dispatchAlbums(
  albums: JmAlbumSummary[],
  targets: ResolvedTargets,
  dedupe: boolean,
  historyDays: number,
): Promise<number> {
  const pluginApi = api;
  if (!pluginApi) return 0;
  const cfg = getJmDailyConfig();

  const sentIds = await sendDailyAlbums(albums, cfg.header, targets, cfg.sendImage, {
    getDiscordClient: () => pluginApi.getDiscordClient(),
    getTelegramBot: () => pluginApi.getTelegramBot(),
    logger: pluginApi.logger,
  });

  if (dedupe && sentIds.length > 0) {
    for (const id of sentIds) markSent(id);
    cleanupHistory(historyDays);
  }
  return sentIds.length;
}

/** 定时任务：今日榜 top N（已发送过的自动跳过） */
async function runDaily(): Promise<void> {
  const pluginApi = api;
  if (!pluginApi) return;
  if (running) {
    pluginApi.logger.warn("上一次搬运仍在进行，跳过本次");
    return;
  }
  running = true;
  const startTime = Date.now();

  try {
    const cfg = getJmDailyConfig();
    pluginApi.logger.info(`开始搬运 JM 推荐 (source=${cfg.source}, limit=${cfg.limit})...`);

    // 0. 未配置 targets 时不发送
    const targets = resolveTargets(cfg);
    if (!hasTargets(targets)) {
      pluginApi.logger.warn("未配置 targets 发送目标，跳过本次定时搬运");
      return;
    }

    // 1+2+3. 拉取榜单 → 去重 → 抓详情 → 按 excludeTags 过滤，数量不足时自动往后补足
    const albums = await collectTopAlbums(cfg.source, cfg.limit, cfg.dedupe, cfg.excludeTags);
    if (albums.length === 0) {
      pluginApi.logger.warn("没有可发送的本子（榜单为空 / 均已发送过 / 全部被 excludeTags 过滤）");
      return;
    }
    pluginApi.logger.info(`已获取 ${albums.length} 本: ${albums.map((a) => `JM${a.id}`).join(", ")}`);

    // 4. 发送 + 记录
    const sentCount = await dispatchAlbums(albums, targets, cfg.dedupe, cfg.historyDays);

    pluginApi.logger.info(
      `搬运完成: ${sentCount}/${albums.length} 本已发送, 耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    pluginApi.logger.error(`搬运失败: ${(err as Error)?.message}`);
  } finally {
    running = false;
  }
}

/** 手动命令：按请求抓取 top N（不过滤去重），只发送到配置的 targets，并记录去重 */
async function runManual(source: JmDailySource, limit: number): Promise<number> {
  const pluginApi = api;
  if (!pluginApi) return 0;
  if (running) {
    pluginApi.logger.warn("上一次搬运仍在进行，请稍后再试");
    return 0;
  }
  running = true;
  const startTime = Date.now();

  try {
    const cfg = getJmDailyConfig();
    pluginApi.logger.info(`手动搬运: source=${source}, limit=${limit}`);

    // 未配置 targets 时不发送
    const targets = resolveTargets(cfg);
    if (!hasTargets(targets)) {
      pluginApi.logger.warn("未配置 targets 发送目标，手动命令不会发送任何内容");
      return 0;
    }

    const albums = await collectTopAlbums(source, limit, false, cfg.excludeTags);
    if (albums.length === 0) {
      pluginApi.logger.warn("没有获取到可发送的本子（榜单为空 / 全部被 excludeTags 过滤）");
      return 0;
    }
    pluginApi.logger.info(`已获取 ${albums.length} 本: ${albums.map((a) => `JM${a.id}`).join(", ")}`);

    const sentCount = await dispatchAlbums(albums, targets, cfg.dedupe, cfg.historyDays);

    pluginApi.logger.info(
      `手动搬运完成: ${sentCount}/${albums.length} 本已发送, 耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    );
    return sentCount;
  } catch (err) {
    pluginApi.logger.error(`手动搬运失败: ${(err as Error)?.message}`);
    return 0;
  } finally {
    running = false;
  }
}

/** Discord 斜杠命令 /jm 处理（与 ai-chat 插件相同模式：插件自注册 interactionCreate） */
function registerDiscordCommandHandler(): void {
  const client = api?.getDiscordClient();
  if (!client) return;

  client.on("interactionCreate", async (interaction: any) => {
    try {
      if (!interaction?.isChatInputCommand || !interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "jm") return;

      const sourceStr = String(interaction.options?.getString("source") ?? "daily");
      const source = SOURCE_ALIASES[sourceStr.toLowerCase()] ?? "daily";
      const limitVal = interaction.options?.getInteger("limit");
      const limit = limitVal ? Math.max(1, Math.min(limitVal, 50)) : getJmDailyConfig().limit;

      await interaction.deferReply?.().catch(() => {});
      const sent = await runManual(source, limit);
      const reply =
        sent > 0
          ? `✅ 已搬运 ${sent} 本（${source}榜），已发送到目标频道`
          : "⚠️ 没有获取到可发送的本子，请先配置 targets 或稍后重试";
      await interaction.editReply?.(reply).catch(() => {});
    } catch (err) {
      api?.logger.error(`Discord /jm 命令处理失败: ${(err as Error)?.message}`);
    }
  });
}

export default {
  manifest: {
    name: "jm-daily",
    version: "1.3.1",
    description:
      "定时/手动搬运 JMComic 榜单本子到 Discord/Telegram/QQ(OneBot11)，支持 /jm 命令、excludeTags 过滤与数量补足（只发送到配置的 targets）",
    author: "shit-bot",
  },
  init: (pluginApi) => {
    api = pluginApi;
    const cfg = getJmDailyConfig();
    if (!cfg.enabled) {
      pluginApi.logger.info("已在配置中禁用");
      return;
    }
    ensureTable();
    pluginApi.registerCronJob(cfg.cron, runDaily);
    pluginApi.logger.info(`已注册定时任务: ${cfg.cron} (source=${cfg.source}, limit=${cfg.limit})`);
    pluginApi.logger.info("支持命令: /jm daily|week|monthly|popular|latest [数量]");
  },
  hooks: {
    onConfigLoaded: () => {
      invalidateJmDailyConfigCache();
    },
    onAfterInit: async () => {
      registerDiscordCommandHandler();
      const cfg = getJmDailyConfig();
      if (!cfg.enabled || !cfg.runOnStart) return;
      api?.logger.info("启动后立即执行一次每日推荐搬运...");
      await runDaily();
    },
    onTelegramMessage: async (ctx: any) => {
      const text = ctx?.message?.text ?? "";
      const parsed = parseJmCommand(text);
      if (!parsed) return false;
      await runManual(parsed.source, parsed.limit);
      return true;
    },
    onOneBotMessage: async (message: any) => {
      const parsed = parseJmCommand(message?.raw_message ?? "");
      if (!parsed) return false;
      await runManual(parsed.source, parsed.limit);
      return true;
    },
    onDiscordMessage: async (message: any) => {
      const parsed = parseJmCommand(message?.content ?? "");
      if (!parsed) return false;
      await runManual(parsed.source, parsed.limit);
      return true;
    },
    onDiscordCommands: () => [
      {
        name: "jm",
        description: "手动获取 JM 榜单并搬运（source: daily/week/month/popular/latest）",
        options: [
          {
            name: "source",
            description: "榜单来源",
            type: 3,
            required: true,
            choices: [
              { name: "日榜 daily", value: "daily" },
              { name: "周榜 week", value: "week" },
              { name: "月榜 month", value: "month" },
              { name: "总人气 popular", value: "popular" },
              { name: "最新 latest", value: "latest" },
            ],
          },
          {
            name: "limit",
            description: "数量 (1-50，默认取插件配置)",
            type: 4,
            required: false,
          },
        ],
      },
    ],
  },
  configSchema: {
    cron: { type: "string", default: "0 20 * * *" },
    runOnStart: { type: "boolean", default: true },
    source: { type: "string", default: "daily" },
    limit: { type: "number", default: 5 },
    sendImage: { type: "boolean", default: true },
    header: { type: "string", default: "📚 JM 今日推荐" },
    dedupe: { type: "boolean", default: true },
    historyDays: { type: "number", default: 30 },
    excludeTags: { type: "array" },
    targets: { type: "object" },
  },
} satisfies PluginDefinition;
