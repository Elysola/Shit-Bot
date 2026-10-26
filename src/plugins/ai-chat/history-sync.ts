import { logger } from '@/logger';
import { getAiConfig } from './config';
import { getChannel, updateChannelSync, upsertChannel, type ChannelInfo } from './channels';
import { deleteMeta, getMeta, setMeta } from '@/plugins/ai-chat/db/meta';
import { compareSnowflakes } from './identity';
import { ingestMessage, type IngestMessage } from './ingest';
import { countChannelMessages } from './messages';

/** 进程启动时刻：早于它、且已经在库里的消息 = 停机前就认识的历史，补缺口时走到这里就算接上了 */
export const PROCESS_STARTED_AT = Date.now();

const PAGE_SIZE = 100;
const DAY_MS = 86400000;
// 单次同步每个频道最多翻多少页，剩下的下次启动再继续，避免一次占用太久
const MAX_PAGES_PER_RUN = 60;

/** 一页原始消息：messages 是可入库的部分；分页和"是否到头"必须按原始页（含被过滤掉的系统消息等）判断 */
export type FetchedPage = {
  messages: IngestMessage[];
  rawCount: number;
  oldestId: string | null;
  newestId: string | null;
  oldestCreatedAt: number;
};

export type SyncChannel = {
  info: ChannelInfo;
  /** 返回 before 之前（不含）最多 100 条消息；before 为空 = 最新的 100 条。无权访问时抛错。 */
  fetchBefore: (before?: string) => Promise<FetchedPage>;
};

/** 把一组原始消息（任意顺序）整理成一页；测试和适配层共用 */
export function pageFrom(messages: IngestMessage[], raw: Array<{ id: string; createdAt: number }> = messages.map((m) => ({ id: m.messageId, createdAt: m.createdAt }))): FetchedPage {
  let oldestId: string | null = null;
  let newestId: string | null = null;
  let oldestCreatedAt = Number.POSITIVE_INFINITY;
  for (const r of raw) {
    if (!oldestId || compareSnowflakes(r.id, oldestId) < 0) oldestId = r.id;
    if (!newestId || compareSnowflakes(r.id, newestId) > 0) newestId = r.id;
    oldestCreatedAt = Math.min(oldestCreatedAt, r.createdAt);
  }
  return { messages, rawCount: raw.length, oldestId, newestId, oldestCreatedAt };
}

export type SyncResult = {
  mode: 'initial' | 'gap';
  pages: number;
  inserted: number;
  complete: boolean;
  exhausted: boolean;
  /** 补缺口时翻到页数上限还没接上已知历史（停机太久，中间可能有缺失） */
  gapUnclosed: boolean;
};

export type SyncOptions = {
  now?: number;
  /** 判断"停机前已认识"的分界，默认是进程启动时刻 */
  startedAt?: number;
  /** 两次请求之间的间隔，默认取配置 history.requestIntervalMs */
  intervalMs?: number;
};

type PageStats = { inserted: number; sawKnown: boolean; minId: string | null; maxId: string | null; minCreatedAt: number };

/**
 * 补缺口的进度记录（kv_meta：history.gap.<频道>）。补缺口一开始就写下 floor（上次成功同步到的最新消息），
 * 接上之后才删除；中途失败（进程崩溃、接口报错）或翻页数到上限还没接上时记录留着，下次从 cursor（已经翻到的最早处）
 * 继续往前补到 floor。否则失败前写入的那一页会被当成"停机前就认识的历史"，剩下的缺口永远补不上。
 */
type GapRecord = {
  floor: string | null;
  cursor: string | null;
  /** 有旧游标时，这次顶部补缺口要补到的位置（开始时已确认连续的最新消息）；顶部接上后清空 */
  top?: string | null;
};

const gapKey = (channelId: string): string => `history.gap.${channelId}`;

function loadGap(channelId: string): GapRecord | null {
  const raw = getMeta(gapKey(channelId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GapRecord>;
    return {
      floor: typeof v.floor === 'string' ? v.floor : null,
      cursor: typeof v.cursor === 'string' ? v.cursor : null,
      top: typeof v.top === 'string' ? v.top : null,
    };
  } catch {
    return null;
  }
}

/** 这一页是否已经翻过了 floor（接上了缺口的下沿） */
function reachedFloor(page: FetchedPage, floor: string | null): boolean {
  return !!floor && !!page.oldestId && compareSnowflakes(page.oldestId, floor) <= 0;
}

function ingestPage(page: FetchedPage, startedAt: number): PageStats {
  const stats: PageStats = {
    inserted: 0,
    sawKnown: false,
    minId: page.oldestId,
    maxId: page.newestId,
    minCreatedAt: page.oldestCreatedAt,
  };
  for (const m of page.messages) {
    let res;
    try {
      res = ingestMessage(m);
    } catch (e) {
      logger.warn('History', `写入消息 ${m.messageId} 失败(跳过):`, (e as Error).message);
      continue;
    }
    if (res === 'inserted') stats.inserted++;
    else if (res !== 'skipped' && m.createdAt < startedAt) stats.sawKnown = true;
  }
  return stats;
}

function minSnowflake(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareSnowflakes(a, b) <= 0 ? a : b;
}

function maxSnowflake(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareSnowflakes(a, b) >= 0 ? a : b;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 同步一个频道的历史：
 * - 第一次同步（库里没有该频道的同步记录）：从最新往前翻，直到 initialDays / maxMessagesPerChannel / 频道开头；
 * - 之后每次（启动或断线重连）：从最新往前翻，直到碰到停机前就已入库的消息（缺口补齐）；
 *   上次初次回望没做完的，再从最早处继续往前。
 * 只会往前（更早）翻页，不依赖 Discord 的 after 分页语义。
 */
export async function syncChannel(ch: SyncChannel, opts: SyncOptions = {}): Promise<SyncResult> {
  const cfg = getAiConfig().history;
  const now = opts.now ?? Date.now();
  const startedAt = opts.startedAt ?? PROCESS_STARTED_AT;
  const interval = opts.intervalMs ?? cfg.requestIntervalMs;
  // 设了保留期时，比保留期更早的消息拉下来也不会入库，不必去翻
  const retention = getAiConfig().memory.observe.retentionDays;
  const cutoff = now - (retention > 0 ? Math.min(cfg.initialDays, retention) : cfg.initialDays) * DAY_MS;
  const maxMessages = cfg.maxMessagesPerChannel;
  const channelId = ch.info.channelId;

  upsertChannel(ch.info, now);
  const state = getChannel(channelId);
  const synced = !!state?.oldest_message_id;
  let oldest = state?.oldest_message_id ?? null;
  let newest = state?.newest_message_id ?? null;
  let complete = !!state?.history_complete;
  let exhausted = !!state?.history_exhausted;
  let pages = 0;
  let inserted = 0;
  let gapUnclosed = false;

  const reachedLimit = (s: PageStats): boolean =>
    s.minCreatedAt < cutoff || (maxMessages > 0 && countChannelMessages(channelId) >= maxMessages);

  // ① 从最新往前：初次同步 = 回望；之后 = 补缺口
  const pendingGap = synced ? loadGap(channelId) : null;
  // 上次补缺口没做完、又不知道翻到了哪里（中途失败）：这次必须一直补到 floor，不能拿"已入库"当接上的依据
  const mustReachFloor = !!pendingGap && !pendingGap.cursor && !!pendingGap.floor;
  if (synced && !pendingGap) setMeta(gapKey(channelId), JSON.stringify({ floor: newest, cursor: null } satisfies GapRecord));
  // 已经有旧游标：这次从顶部往下补，同样不能拿"已入库"当接上的依据，要补到开始时已确认的位置——先记下来，失败了下次接着用
  let topFloor: string | null = null;
  if (synced && pendingGap?.cursor) {
    topFloor = pendingGap.top ?? newest;
    if (!pendingGap.top && topFloor) setMeta(gapKey(channelId), JSON.stringify({ ...pendingGap, top: topFloor } satisfies GapRecord));
  }
  let before: string | undefined;
  let lowest: string | null = null;
  let connected = false;
  while (pages < MAX_PAGES_PER_RUN) {
    const page = await ch.fetchBefore(before);
    pages++;
    if (page.rawCount === 0) {
      exhausted = true;
      if (!synced) complete = true;
      connected = true;
      break;
    }
    const s = ingestPage(page, startedAt);
    inserted += s.inserted;
    newest = maxSnowflake(newest, s.maxId);
    lowest = minSnowflake(lowest, s.minId);
    if (!synced) oldest = minSnowflake(oldest, s.minId);
    if (synced && (mustReachFloor ? reachedFloor(page, pendingGap!.floor) : topFloor ? reachedFloor(page, topFloor) : s.sawKnown)) {
      connected = true;
      break;
    }
    if (!synced && reachedLimit(s)) {
      complete = true;
      connected = true;
      break;
    }
    if (page.rawCount < PAGE_SIZE) {
      exhausted = true;
      if (!synced) complete = true;
      connected = true;
      break;
    }
    before = s.minId ?? undefined;
    if (interval > 0) await sleep(interval);
  }
  if (synced && !connected) {
    gapUnclosed = true;
    logger.warn('History', `频道 ${ch.info.name ?? channelId} 停机期间消息过多，翻了 ${pages} 页仍未接上已知历史，剩下的下次继续补`);
  }

  // ①b 上次翻页数到上限、记下了翻到哪里的缺口：顶部接上之后，从 cursor 继续往前补到 floor
  let cursorGapOpen = false;
  if (synced && connected && pendingGap?.cursor && pendingGap.floor) {
    let cursor: string = pendingGap.cursor;
    let closed = false;
    while (pages < MAX_PAGES_PER_RUN) {
      const page = await ch.fetchBefore(cursor);
      pages++;
      if (page.rawCount === 0) {
        closed = true;
        break;
      }
      inserted += ingestPage(page, startedAt).inserted;
      if (reachedFloor(page, pendingGap.floor) || page.rawCount < PAGE_SIZE) {
        closed = true;
        break;
      }
      cursor = page.oldestId ?? cursor;
      if (interval > 0) await sleep(interval);
    }
    if (!closed) {
      cursorGapOpen = gapUnclosed = true;
      // 顶部已经接上：只剩旧缺口的游标
      setMeta(gapKey(channelId), JSON.stringify({ floor: pendingGap.floor, cursor, top: null } satisfies GapRecord));
    }
  }
  if (synced && !connected) {
    // 顶部这段没接上：记下翻到的最早处；下沿保持最早那次缺口的 floor（中间已经补过的部分下次重翻也只是去重）
    const floor = pendingGap?.floor ?? state?.newest_message_id ?? null;
    if (lowest && floor) setMeta(gapKey(channelId), JSON.stringify({ floor, cursor: lowest } satisfies GapRecord));
  } else if (synced && !cursorGapOpen) {
    deleteMeta(gapKey(channelId));
  }

  // ② 继续上次没做完的初次回望
  if (synced && !complete && !exhausted && oldest) {
    let deepBefore: string = oldest;
    while (pages < MAX_PAGES_PER_RUN) {
      const page = await ch.fetchBefore(deepBefore);
      pages++;
      if (page.rawCount === 0) {
        complete = exhausted = true;
        break;
      }
      const s = ingestPage(page, startedAt);
      inserted += s.inserted;
      oldest = minSnowflake(oldest, s.minId);
      if (reachedLimit(s)) {
        complete = true;
        break;
      }
      if (page.rawCount < PAGE_SIZE) {
        complete = exhausted = true;
        break;
      }
      deepBefore = s.minId ?? deepBefore;
      if (interval > 0) await sleep(interval);
    }
  }

  updateChannelSync(
    channelId,
    {
      oldest_message_id: oldest,
      newest_message_id: newest,
      history_complete: complete,
      history_exhausted: exhausted,
      last_gapfill_at: now,
      ...(synced ? {} : { last_backfill_at: now }),
      readable: true,
    },
    now
  );
  return { mode: synced ? 'gap' : 'initial', pages, inserted, complete, exhausted, gapUnclosed };
}

/**
 * 按需继续往更早翻（模型要读的历史比库里多时调用），直到库里有 targetCount 条或翻到频道开头。
 * 不受 initialDays 限制（这是用户明确要看更早的内容）。
 */
export async function backfillChannelTo(ch: SyncChannel, targetCount: number, opts: SyncOptions = {}): Promise<number> {
  const channelId = ch.info.channelId;
  const interval = opts.intervalMs ?? getAiConfig().history.requestIntervalMs;
  const startedAt = opts.startedAt ?? PROCESS_STARTED_AT;
  upsertChannel(ch.info, opts.now ?? Date.now());
  let state = getChannel(channelId);
  if (!state?.oldest_message_id) {
    await syncChannel(ch, opts);
    state = getChannel(channelId);
  }
  let oldest = state?.oldest_message_id ?? null;
  let exhausted = !!state?.history_exhausted;
  let pages = 0;
  while (!exhausted && oldest && countChannelMessages(channelId) < targetCount && pages < MAX_PAGES_PER_RUN) {
    const page = await ch.fetchBefore(oldest);
    pages++;
    if (page.rawCount === 0) {
      exhausted = true;
      break;
    }
    const s = ingestPage(page, startedAt);
    oldest = minSnowflake(oldest, s.minId);
    if (page.rawCount < PAGE_SIZE) exhausted = true;
    if (interval > 0) await sleep(interval);
  }
  updateChannelSync(channelId, { oldest_message_id: oldest, history_exhausted: exhausted, last_backfill_at: Date.now() });
  return countChannelMessages(channelId);
}

// 全局串行队列：所有历史同步请求排队执行，避免并发打 Discord 接口、也不和实时消息抢资源
let queue: Promise<unknown> = Promise.resolve();

export function enqueueHistoryTask<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}
