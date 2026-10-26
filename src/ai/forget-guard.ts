import { createHash, randomBytes } from 'crypto';
import { getDatabase, getDatabaseGeneration } from '../storage';
import { getMeta, setMeta } from './db/meta';
import { isAiSchemaReady } from './db/schema';

/**
 * /forget-me 的两道保险（与 forget.ts 分开，入库热路径引用它不会形成循环依赖）：
 * 1. 删除墓碑：记下"这个人在某时刻之前的内容不能再入库"，防止历史回望 / 按需补拉把删掉的消息导入回来。
 *    只存加盐哈希（盐在 kv_meta 里，随库生成），库里不留明文 ID。
 * 2. 删除代次：每次 /forget-me、每删除一条记忆（/forget、模型的 forget_memory）都加一。调用模型的任务开始时记下代次，
 *    写入前发现变了就放弃这次结果、稍后用新数据重做，避免"请求发出时带着被删的数据、返回时已经删除"把数据写回去。
 *    删除很少发生，偶尔让几个进行中的任务重做一次的代价可以接受。
 */

let epoch = 0;

export function forgetEpoch(): number {
  return epoch;
}

export function bumpForgetEpoch(): void {
  epoch++;
}

/** 处理期间有数据被删除：结果作废、稍后用最新数据重做（任务按普通错误退避重试） */
export class ForgetChangedError extends Error {}

/** 写入前调用：从 start 到现在有人执行过 /forget-me 就抛出 ForgetChangedError */
export function assertNoForgetSince(start: number): void {
  if (epoch !== start) throw new ForgetChangedError('处理期间有数据被删除（/forget-me 或删除记忆），稍后用最新数据重做');
}

const CACHE_MAX = 5000;
let generation = -1;
let salt: string | null = null;
const cache = new Map<string, number | null>();

function ensureFresh(): void {
  const g = getDatabaseGeneration();
  if (g === generation) return;
  generation = g;
  salt = null;
  cache.clear();
}

function hashOf(userId: string): string {
  if (!salt) {
    salt = getMeta('forget.salt');
    if (!salt) {
      salt = randomBytes(16).toString('hex');
      setMeta('forget.salt', salt);
    }
  }
  return createHash('sha256').update(`${salt}:${userId}`).digest('hex');
}

/** 记下删除墓碑（在 forgetUser 的事务里调用） */
export function recordForgotten(userId: string, at: number): void {
  ensureFresh();
  getDatabase().run(
    'INSERT INTO forgotten_users (id_hash, forgotten_at) VALUES (?, ?) ON CONFLICT(id_hash) DO UPDATE SET forgotten_at = excluded.forgotten_at',
    [hashOf(userId), at]
  );
  cache.set(userId, at);
}

/** 这个人最近一次 /forget-me 的时刻；没有删除过返回 null */
export function forgottenAt(userId: string): number | null {
  if (!isAiSchemaReady()) return null;
  ensureFresh();
  const hit = cache.get(userId);
  if (hit !== undefined) return hit;
  const row = getDatabase().query('SELECT forgotten_at FROM forgotten_users WHERE id_hash = ?').get(hashOf(userId)) as { forgotten_at: number } | null;
  if (cache.size >= CACHE_MAX) cache.clear();
  const value = row?.forgotten_at ?? null;
  cache.set(userId, value);
  return value;
}

/** 这条内容（创建于 createdAt）属于 TA 删除之前的数据 */
export function forgottenBefore(userId: string, createdAt: number): boolean {
  const t = forgottenAt(userId);
  return t !== null && createdAt <= t;
}

/** 记一条消息墓碑（bot 自己发出、但因为期间发生删除而不该入库的消息） */
export function recordForgottenMessage(messageId: string, at: number): void {
  if (!isAiSchemaReady()) return;
  getDatabase().run('INSERT OR IGNORE INTO forgotten_messages (message_id, forgotten_at) VALUES (?, ?)', [messageId, at]);
}

/** 这条（bot 自己的）消息是 /forget-me 时连带删掉的 */
export function isForgottenMessage(messageId: string): boolean {
  if (!isAiSchemaReady()) return false;
  return !!getDatabase().query('SELECT 1 FROM forgotten_messages WHERE message_id = ?').get(messageId);
}
