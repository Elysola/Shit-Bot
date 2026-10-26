import { getPlugin } from "@/plugins";

export type JmDailySource = "daily" | "week" | "month" | "popular" | "latest";

export interface JmDailyTargets {
  /** Telegram chat id 列表（群/频道） */
  telegram?: string[];
  /** Discord channel id 列表 */
  discord?: string[];
  /** OneBot 群号列表 */
  onebot?: number[];
}

export interface JmDailyOptions {
  enabled: boolean;
  /** node-cron 表达式（服务器本地时区），默认每天 20:00 */
  cron: string;
  /** 启动后是否立即执行一次 */
  runOnStart: boolean;
  /**
   * 数据源：
   * - daily   — 今日榜（默认，jmcomic 移动端 API mv_t）
   * - week    — 周榜
   * - month   — 月榜
   * - popular — 总人气
   * - latest  — 最新上架
   */
  source: JmDailySource;
  /** 每次最多搬运的本子数量 */
  limit: number;
  /** 是否下载并附带封面图 */
  sendImage: boolean;
  /** 发送时的标题头 */
  header: string;
  /** 是否去重（同一本子只发送一次，记录在 SQLite） */
  dedupe: boolean;
  /** 去重记录保留天数 */
  historyDays: number;
  /** 需要排除的标签：本子标签命中任意一个即跳过发送 */
  excludeTags: string[];
  /** 显式指定发送目标；不配置时自动使用 groups 配置的频道 */
  targets?: JmDailyTargets;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

const defaults: JmDailyOptions = {
  enabled: true,
  cron: "0 20 * * *",
  runOnStart: true,
  source: "daily",
  limit: 5,
  sendImage: true,
  header: "📚 JM 今日推荐",
  dedupe: true,
  historyDays: 30,
  excludeTags: [],
};

let cached: JmDailyOptions | null = null;

export function getJmDailyConfig(): JmDailyOptions {
  if (cached) return cached;

  const plugin = getPlugin("jm-daily");
  const raw = (plugin?.config?.options || {}) as Record<string, unknown>;
  const rawTargets = (raw.targets || {}) as Record<string, unknown>;

  const sources: JmDailySource[] = ["daily", "week", "month", "popular", "latest"];
  const source = sources.includes(raw.source as JmDailySource) ? (raw.source as JmDailySource) : defaults.source;

  const cfg: JmDailyOptions = {
    ...defaults,
    ...raw,
    enabled: (raw.enabled as boolean) ?? defaults.enabled,
    cron: (raw.cron as string) || defaults.cron,
    runOnStart: (raw.runOnStart as boolean) ?? defaults.runOnStart,
    source,
    limit: clampInt(raw.limit, defaults.limit, 1, 50),
    sendImage: (raw.sendImage as boolean) ?? defaults.sendImage,
    header: (raw.header as string) || defaults.header,
    dedupe: (raw.dedupe as boolean) ?? defaults.dedupe,
    historyDays: clampInt(raw.historyDays, defaults.historyDays, 1, 3650),
    excludeTags: Array.isArray(raw.excludeTags)
      ? (raw.excludeTags as string[])
          .map((t) => String(t).trim())
          .filter(Boolean)
      : [],
    targets: {
      telegram: Array.isArray(rawTargets.telegram) ? (rawTargets.telegram as string[]).map(String) : undefined,
      discord: Array.isArray(rawTargets.discord) ? (rawTargets.discord as string[]).map(String) : undefined,
      onebot: Array.isArray(rawTargets.onebot) ? (rawTargets.onebot as number[]).map(Number) : undefined,
    },
  };

  cached = cfg;
  return cfg;
}

export function invalidateJmDailyConfigCache(): void {
  cached = null;
}
