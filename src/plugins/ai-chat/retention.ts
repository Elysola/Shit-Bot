import { getAiConfig } from './config';
import { getDatabase } from '@/storage';
import { dayKeyUtc8 } from './time';
import { PRIORITY, enqueueJob, registerJobHandler, registerScheduler } from './worker';

const DAY = 86400_000;
const BATCH = 5000;

/** 原始消息的最早保留时刻；retentionDays = 0 表示永久保留，返回 null */
export function retentionCutoff(now: number = Date.now()): number | null {
  const days = getAiConfig().memory.observe.retentionDays;
  return days > 0 ? now - days * DAY : null;
}

/**
 * 保留期清理（PLAN §15 `memory.observe.retentionDays`）：删除超过保留期的原始消息（含升级前保留的旧消息表）和在线活动记录。
 * 已经提炼出来的记忆、画像、好感不受影响（它们引用的消息编号会变成悬空的，这是预期的）。
 * 分批删除，避免一次长事务卡住消息入库。
 */
export function runRetention(now: number = Date.now()): { messages: number; sessions: number } {
  const cutoff = retentionCutoff(now);
  if (cutoff === null) return { messages: 0, sessions: 0 };
  const db = getDatabase();
  let messages = 0;
  for (;;) {
    // 先取 id 再删（bun:sqlite 的 changes 会把全文索引触发器的改动也算进去，不能拿来计数）
    const ids = (db.query(`SELECT id FROM messages WHERE created_at < ? LIMIT ${BATCH}`).all(cutoff) as Array<{ id: number }>).map((r) => r.id);
    if (ids.length === 0) break;
    db.run(`DELETE FROM messages WHERE id IN (${ids.join(',')})`);
    messages += ids.length;
    if (ids.length < BATCH) break;
  }
  // 升级前的原始消息表（迁移时改名保留）里同样是原话，同样受保留期约束
  for (const t of ['_legacy_channel_messages', '_legacy_ai_conversations']) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
    const n = (db.query(`SELECT COUNT(*) AS c FROM "${t}" WHERE created_at < ?`).get(cutoff) as { c: number }).c;
    if (n > 0) db.run(`DELETE FROM "${t}" WHERE created_at < ?`, [cutoff]);
    messages += n;
  }
  const sessions = db.run('DELETE FROM activity_sessions WHERE ended_at < ?', [cutoff]).changes;
  if (messages > 0) {
    try {
      db.run("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    } catch {
      // 尽力而为
    }
  }
  if (messages + sessions > 0) console.log(`[Retention] 删除了 ${messages} 条超过保留期的消息、${sessions} 条在线活动记录`);
  return { messages, sessions };
}

export function registerRetention(): void {
  registerJobHandler('retention', async () => {
    runRetention();
  });
  registerScheduler('retention', 6 * 3600_000, (now) => {
    if (retentionCutoff(now) === null) return;
    enqueueJob('retention', {}, { priority: PRIORITY.maintenance, dedupeKey: `retention:${dayKeyUtc8(now)}` }, now);
  });
}
