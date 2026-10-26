import { logger } from '@/logger';
import { getAiConfig } from './config';
import { getDatabase } from '@/storage';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import { RateLimitedError, getTokensUsedToday, type LlmPurpose } from './llm-client';

/**
 * 进程内的后台任务队列（数据在 jobs 表里，重启不丢）：
 * - 优先级高的先跑；同一 dedupe_key 同时只会有一个待执行/执行中的任务；
 * - 失败指数退避重试，最多 5 次；超过每日 token 预算的任务顺延到第二天；
 * - 调度器每 30 秒运行一次已注册的 scheduler，按需投递新任务。
 */

export type JobType = 'extract_window' | 'refresh_profile' | 'appraise' | 'embed' | 'decay' | 'retention';

export type JobRow = {
  id: number;
  type: JobType;
  priority: number;
  dedupe_key: string | null;
  payload: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  run_after: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

/** 任务优先级（越大越先执行）：PLAN §7.1 */
export const PRIORITY = {
  appraise: 90,
  extractLive: 70,
  profile: 50,
  embed: 40,
  extractBackfill: 30,
  maintenance: 10,
} as const;

/** 任务处理失败但不该重试时抛出（比如数据已经不存在） */
export class PermanentJobError extends Error {}

/** 今日预算已用完：任务顺延到第二天 */
export class BudgetExceededError extends Error {}

type Handler = (payload: unknown, job: JobRow) => Promise<void>;
type Scheduler = (now: number) => void;

const handlers = new Map<JobType, Handler>();
const schedulers: Array<{ name: string; fn: Scheduler; everyMs: number; lastRun: number }> = [];
// 受每日预算约束的任务类型 → 计入预算的用途
const BUDGETED: Partial<Record<JobType, LlmPurpose[]>> = {
  extract_window: ['extract', 'profile', 'appraise'],
  refresh_profile: ['extract', 'profile', 'appraise'],
};

/** 任务最多执行的次数（含第一次）；失败到这个次数就标记为 failed、不再重试 */
export const MAX_ATTEMPTS = 5;
const UTC8 = 8 * 3600_000;

export function registerJobHandler(type: JobType, handler: Handler): void {
  handlers.set(type, handler);
}

/** 注册一个周期性调度器（例如"检查哪些频道该抽取了"） */
export function registerScheduler(name: string, everyMs: number, fn: Scheduler): void {
  if (schedulers.some((s) => s.name === name)) return;
  schedulers.push({ name, fn, everyMs, lastRun: 0 });
}

export type EnqueueOptions = { priority?: number; dedupeKey?: string; runAfter?: number };

/** 投递任务；dedupeKey 相同的任务已在排队/执行时返回 null（不重复投递） */
export function enqueueJob(type: JobType, payload: unknown, opts: EnqueueOptions = {}, now: number = Date.now()): number | null {
  if (!isAiSchemaReady()) return null;
  const res = getDatabase().run(
    `INSERT OR IGNORE INTO jobs (type, priority, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    [type, opts.priority ?? 50, opts.dedupeKey ?? null, JSON.stringify(payload ?? null), opts.runAfter ?? now, now, now]
  );
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

/** 下一个 UTC+8 零点 */
export function nextUtc8Midnight(now: number): number {
  const d = new Date(now + UTC8);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - UTC8;
}

/**
 * 现在能不能提炼记忆（按运行时配置）：关掉被动观察时库里只有和 bot 的直接对话，照常提炼；
 * 但开着频道总结时所有消息仍会入库（只供总结），这时不提炼。调度、领取任务、每个窗口执行前都用它。
 */
export function extractionAllowed(): boolean {
  const ai = getAiConfig();
  return ai.enabled && ai.memory.enabled && !(!ai.memory.observe.enabled && ai.summary?.enabled);
}

/** 按当前（运行时）配置判断这类任务能不能执行：WebUI 改了开关立即生效 */
function typeEnabled(type: JobType): boolean {
  const ai = getAiConfig();
  if (!ai.enabled) return false;
  switch (type) {
    case 'extract_window':
      return extractionAllowed();
    case 'refresh_profile':
    case 'embed':
      return ai.memory.enabled;
    case 'appraise':
      return ai.memory.enabled && (ai.affinity.enabled || ai.mood.enabled);
    case 'decay':
      return ai.affinity.enabled;
    case 'retention':
      return true;
  }
}

function claimNext(now: number): JobRow | null {
  const db = getDatabase();
  let job: JobRow | null = null;
  // 只领取注册了处理器、且功能当前开着的任务：关掉的功能（比如运行中关了记忆）的任务原样留在队列里，重新打开后继续
  const types = [...handlers.keys()].filter(typeEnabled);
  if (types.length === 0) return null;
  db.transaction(() => {
    job = db
      .query(
        `SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ? AND type IN (${types.map(() => '?').join(',')})
         ORDER BY priority DESC, run_after ASC, id ASC LIMIT 1`
      )
      .get(now, ...types) as JobRow | null;
    if (job) db.run("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?", [now, job.id]);
  })();
  return job;
}

function budgetExhausted(type: JobType, now: number): boolean {
  const purposes = BUDGETED[type];
  const budget = getAiConfig().memory.extractor.dailyTokenBudget;
  if (!purposes || budget <= 0) return false;
  return getTokensUsedToday(purposes, now) >= budget;
}

/** 执行一个任务（测试可直接调用）；返回执行结果 */
export async function runJob(job: JobRow, now: number = Date.now()): Promise<'done' | 'retry' | 'failed' | 'postponed'> {
  const db = getDatabase();
  const handler = handlers.get(job.type);
  if (!handler) {
    db.run("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [`没有 ${job.type} 的处理器`, now, job.id]);
    return 'failed';
  }
  if (budgetExhausted(job.type, now)) {
    db.run("UPDATE jobs SET status = 'pending', run_after = ?, updated_at = ? WHERE id = ?", [nextUtc8Midnight(now), now, job.id]);
    return 'postponed';
  }
  try {
    await handler(JSON.parse(job.payload), job);
    db.run("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?", [Date.now(), job.id]);
    return 'done';
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (e instanceof BudgetExceededError) {
      db.run("UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?", [nextUtc8Midnight(now), msg, now, job.id]);
      return 'postponed';
    }
    if (e instanceof RateLimitedError) {
      // 被上游限流：等暂停结束再试，不算一次失败
      db.run("UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?", [e.retryAt, msg.slice(0, 1000), now, job.id]);
      return 'postponed';
    }
    const attempts = job.attempts + 1;
    if (e instanceof PermanentJobError || attempts >= MAX_ATTEMPTS) {
      db.run("UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?", [attempts, msg.slice(0, 1000), now, job.id]);
      logger.warn('Jobs', `${job.type}#${job.id} 失败，不再重试: ${msg}`);
      return 'failed';
    }
    const backoff = Math.min(30_000 * Math.pow(2, attempts - 1), 30 * 60_000);
    db.run("UPDATE jobs SET status = 'pending', attempts = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?", [
      attempts,
      msg.slice(0, 1000),
      now + backoff,
      now,
      job.id,
    ]);
    logger.warn('Jobs', `${job.type}#${job.id} 出错，${Math.round(backoff / 1000)}s 后重试 (${attempts}/${MAX_ATTEMPTS - 1}): ${msg}`);
    return 'retry';
  }
}

/** 运行所有到期的调度器（测试可直接调用） */
export function runSchedulers(now: number = Date.now(), force = false): void {
  for (const s of schedulers) {
    if (!force && now - s.lastRun < s.everyMs) continue;
    s.lastRun = now;
    try {
      s.fn(now);
    } catch (e) {
      logger.warn('Jobs', `调度器 ${s.name} 出错(忽略):`, (e as Error).message);
    }
  }
}

/** 取出并执行所有当前可执行的任务，直到队列空（测试用；生产环境由循环驱动） */
export async function drainJobs(now: number = Date.now(), limit = 100): Promise<number> {
  let n = 0;
  while (n < limit) {
    const job = claimNext(now);
    if (!job) break;
    await runJob(job, now);
    n++;
  }
  return n;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = 0;
let stopped = true;

async function pump(): Promise<void> {
  if (stopped || !isAiSchemaReady()) return;
  const concurrency = getAiConfig().memory.extractor.concurrency;
  while (!stopped && running < concurrency) {
    const job = claimNext(Date.now());
    if (!job) return;
    running++;
    runJob(job)
      .catch((e) => logger.warn('Jobs', '执行任务异常:', (e as Error).message))
      .finally(() => {
        running--;
        void pump();
      });
  }
}

/** 启动后台任务循环：先把上次进程退出时没跑完的任务放回队列 */
export function startWorker(): void {
  if (!isAiSchemaReady() || timer) return;
  const db = getDatabase();
  const reset = db.run("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'", [Date.now()]).changes;
  if (reset > 0) logger.info('Jobs', `恢复了 ${reset} 个上次未完成的任务`);
  stopped = false;
  timer = setInterval(() => {
    try {
      runSchedulers();
      // 完成的任务保留 1 天便于排查，失败的保留 7 天
      db.run("DELETE FROM jobs WHERE (status = 'done' AND updated_at < ?) OR (status = 'failed' AND updated_at < ?)", [
        Date.now() - 86400_000,
        Date.now() - 7 * 86400_000,
      ]);
    } catch (e) {
      logger.warn('Jobs', '调度出错(忽略):', (e as Error).message);
    }
    void pump();
  }, 30_000);
  // 启动后先跑一轮调度
  setTimeout(() => {
    runSchedulers(Date.now(), true);
    void pump();
  }, 5_000);
  logger.info('Jobs', '后台任务已启动');
}

export function stopWorker(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** 唤醒任务循环（投递了紧急任务后调用，不必等下一个 30 秒） */
export function kickWorker(): void {
  if (!stopped) void pump();
}

export function jobStats(): Record<string, number> {
  const rows = getDatabase().query('SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status').all() as Array<{ type: string; status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[`${r.type}.${r.status}`] = r.n;
  return out;
}
