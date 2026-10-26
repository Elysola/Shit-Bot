import { JmApiClient, JmcomicText, JmMagicConstants, JmModuleConfig, newPostman } from "jmcomic-crawler";
import type { JmDailySource } from "./config";
import { logger } from "@/logger";

export interface JmAlbumSummary {
  /** 本子 id */
  id: string;
  /** 标题 */
  name: string;
  /** 作者列表 */
  authors: string[];
  /** 标签列表 */
  tags: string[];
  /** 总观看数 */
  views: number;
  /** 点赞数 */
  likes: number;
  /** 评论数 */
  comments: number;
  /** 封面 URL */
  coverUrl: string;
  /** 详情页链接 */
  url: string;
}

/** 数据源回退链：今日榜偶发为空时依次回退到周榜/月榜/总人气 */
const SOURCE_CHAIN: Record<JmDailySource, JmDailySource[]> = {
  daily: ["daily", "week", "month", "popular"],
  week: ["week"],
  month: ["month"],
  popular: ["popular"],
  latest: ["latest"],
};

let clientPromise: Promise<JmApiClient> | null = null;

async function getClient(): Promise<JmApiClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      JmModuleConfig.FLAG_ENABLE_JM_LOG = false;
      const postman = await newPostman();
      const client = new JmApiClient(postman, [...JmModuleConfig.DOMAIN_API_LIST], 3);
      // 显式等待初始化（自动更新域名 + 获取 cookies），失败时重试
      try {
        await (client as unknown as { afterInit(): Promise<void> }).afterInit();
      } catch (err) {
        logger.warn("JMDaily", `JM 客户端初始化失败，将重试: ${(err as Error)?.message}`);
        clientPromise = null;
        throw err;
      }
      return client;
    })();
  }
  return clientPromise;
}

/** 单个来源最多翻页数，防止分页异常时死循环 */
const MAX_RANKING_PAGES = 5;

/** 获取指定来源的榜单本子 id 列表（按榜单顺序跨页拉取，已过滤掉重复 id；主源为空时自动回退） */
export async function fetchDailyAlbumIds(source: JmDailySource, limit: number): Promise<string[]> {
  const client = await getClient();
  for (const s of SOURCE_CHAIN[source]) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let page = 1; ids.length < limit && page <= MAX_RANKING_PAGES; page++) {
      const pageIds = await fetchIdsPage(s, page, client);
      if (pageIds.length === 0) break;
      for (const id of pageIds) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          ids.push(key);
        }
        if (ids.length >= limit) break;
      }
    }
    if (ids.length > 0) return ids;
  }
  return [];
}

/** 拉取指定来源某一页的榜单 id 列表（日/周/月榜走专用 API，人气/最新走 categoriesFilter） */
async function fetchIdsPage(source: JmDailySource, page: number, client: JmApiClient): Promise<string[]> {
  let data: unknown;
  switch (source) {
    case "daily":
      data = await client.dayRanking(page);
      break;
    case "week":
      data = await client.weekRanking(page);
      break;
    case "month":
      data = await client.monthRanking(page);
      break;
    case "popular":
      data = await client.categoriesFilter(
        page,
        JmMagicConstants.TIME_ALL,
        JmMagicConstants.CATEGORY_ALL,
        JmMagicConstants.ORDER_BY_VIEW,
      );
      break;
    case "latest":
      data = await client.categoriesFilter(
        page,
        JmMagicConstants.TIME_ALL,
        JmMagicConstants.CATEGORY_ALL,
        JmMagicConstants.ORDER_BY_LATEST,
      );
      break;
  }
  const content = (data as unknown as { content: [string, Record<string, any>][] }).content ?? [];
  return content.map(([id]) => String(id)).filter(Boolean);
}

/** 获取本子详情（走 /album 原始 API，规避实体解析 bug） */
export async function fetchAlbumSummary(id: string): Promise<JmAlbumSummary | null> {
  const client = await getClient();
  const resp = await client.reqApi(client.appendParamsToUrl("/album", { id }), true, true);
  const d = resp.modelData as Record<string, any>;
  if (!d || d.id === undefined || d.name === undefined || d.name === null) return null;

  const toStrArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === "string" && v) return [v];
    return [];
  };

  return {
    id: String(d.id),
    name: String(d.name),
    authors: toStrArray(d.author),
    tags: toStrArray(d.tags),
    views: Number(d.total_views) || 0,
    likes: Number(d.likes) || 0,
    comments: Number(d.comment_total) || 0,
    coverUrl: JmcomicText.getAlbumCoverUrl(String(d.id)),
    url: `https://18comic.vip/album/${d.id}/`,
  };
}

/** 下载封面图（失败返回 null，调用方自行降级为纯文本） */
export async function downloadCover(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        Referer: "https://18comic.vip/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) return null;
    return buf;
  } catch (err) {
    logger.warn("JMDaily", `封面下载失败 ${url}: ${(err as Error)?.message}`);
    return null;
  }
}

/** 格式化本子的文本描述：plain 用于 Discord/OneBot，html 用于 Telegram（需转义） */
export function formatAlbumText(album: JmAlbumSummary, index: number, mode: "plain" | "html" = "plain"): string {
  const esc = (s: string) => (mode === "html" ? escapeHTML(s) : s);
  const lines: string[] = [];
  lines.push(`📖 ${index}. ${esc(album.name)}`);
  if (album.authors.length > 0) lines.push(`✍️ 作者: ${esc(album.authors.join("、"))}`);
  if (album.tags.length > 0) lines.push(`🏷️ 标签: ${esc(album.tags.slice(0, 6).join("、"))}`);
  const stats: string[] = [];
  if (album.views > 0) stats.push(`👀 ${formatNumber(album.views)}`);
  if (album.likes > 0) stats.push(`❤️ ${formatNumber(album.likes)}`);
  if (album.comments > 0) stats.push(`💬 ${album.comments}`);
  if (stats.length > 0) lines.push(stats.join("  "));
  lines.push(`🔗 ${album.url}`);
  return lines.join("\n");
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { escapeHTML };

function formatNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
