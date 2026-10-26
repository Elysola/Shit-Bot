import { getAiConfig } from './config';
import { getDatabase } from '@/storage';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import type { AffinityLevel, PersonaCard } from '@/plugins/ai-chat/persona/card';
import { cleanData, cleanName } from './untrusted';

/** 好感度（PLAN §8）：-100…100，按"灵魂"全局一份；数值只在内部使用，不会出现在给模型或用户看的文本里 */

export type Relationship = {
  user_id: string;
  affinity: number;
  impression: string | null;
  pet_name: string | null;
  interactions: number;
  first_interaction_at: number | null;
  last_interaction_at: number | null;
  updated_at: number;
};

export type AffinitySource = 'appraisal' | 'observed' | 'decay' | 'admin';

export const LEVEL_LABEL: Record<AffinityLevel, string> = {
  hostile: '厌恶',
  cold: '冷淡',
  neutral: '普通',
  friendly: '友好',
  close: '亲近',
  devoted: '挚友',
};

const DAY = 86400_000;
const UTC8 = 8 * 3600_000;

export function levelOf(score: number): AffinityLevel {
  if (score >= 80) return 'devoted';
  if (score >= 50) return 'close';
  if (score >= 20) return 'friendly';
  if (score >= -19) return 'neutral';
  if (score >= -59) return 'cold';
  return 'hostile';
}

export function getRelationship(userId: string): Relationship | null {
  if (!isAiSchemaReady()) return null;
  return getDatabase().query('SELECT * FROM relationships WHERE user_id = ?').get(userId) as Relationship | null;
}

function ensureRelationship(userId: string, now: number): Relationship {
  getDatabase().run('INSERT OR IGNORE INTO relationships (user_id, affinity, updated_at) VALUES (?, 0, ?)', [userId, now]);
  return getRelationship(userId)!;
}

function dayStart(now: number): number {
  const d = new Date(now + UTC8);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - UTC8;
}

/** 今天（UTC+8）来自对话与旁听的累计涨跌 */
function todaySums(userId: string, now: number): { gain: number; loss: number } {
  const row = getDatabase()
    .query(
      `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS gain,
              COALESCE(SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END), 0) AS loss
       FROM affinity_events WHERE user_id = ? AND source IN ('appraisal','observed') AND created_at >= ?`
    )
    .get(userId, dayStart(now)) as { gain: number; loss: number };
  return row;
}

export type AffinityEvent = { delta: number; category: string | null; reason: string; source: AffinitySource; created_at: number };

/** 今天（UTC+8）的好感变化记录，最近的在后；给评估模型看，由它自己判断同类的事要不要递减 */
export function todayAffinityEvents(userId: string, now: number = Date.now(), limit = 20): AffinityEvent[] {
  return (
    getDatabase()
      .query(
        `SELECT delta, category, reason, source, created_at FROM affinity_events
         WHERE user_id = ? AND created_at >= ? AND source IN ('appraisal','observed') ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(userId, dayStart(now), limit) as AffinityEvent[]
  ).reverse();
}

export type AffinityChange = { applied: number; before: number; after: number; levelBefore: AffinityLevel; levelAfter: AffinityLevel };

/**
 * 应用一次好感变化。变化多少由评估模型站在人设立场判断；服务端只做安全护栏（防注入成功后一次跳满）：
 * - 单次：对话 [-maxLoss, +maxGain]，旁听 [-3, +2]；
 * - 每日：对话 + 旁听累计不超过 +dailyGainCap / -dailyLossCap；
 * 每次变化都写入 affinity_events（可追溯）。
 */
export function applyAffinityDelta(
  userId: string,
  rawDelta: number,
  reason: string,
  source: AffinitySource,
  opts: { guildId?: string | null; messageId?: string | null; category?: string | null; now?: number } = {}
): AffinityChange {
  const cfg = getAiConfig().affinity;
  const now = opts.now ?? Date.now();
  const db = getDatabase();
  let result!: AffinityChange;
  db.transaction(() => {
    const rel = ensureRelationship(userId, now);
    let delta = Math.round(Number(rawDelta) || 0);
    if (source === 'appraisal') delta = Math.max(-cfg.maxLossPerInteraction, Math.min(cfg.maxGainPerInteraction, delta));
    if (source === 'observed') delta = Math.max(-3, Math.min(2, delta));
    if (delta !== 0 && (source === 'appraisal' || source === 'observed')) {
      const today = todaySums(userId, now);
      if (delta > 0) delta = Math.min(delta, Math.max(0, cfg.dailyGainCap - today.gain));
      else delta = Math.max(delta, -Math.max(0, cfg.dailyLossCap + today.loss));
    }
    const before = rel.affinity;
    const after = Math.max(-100, Math.min(100, before + delta));
    const applied = after - before;
    if (applied !== 0) {
      db.run('UPDATE relationships SET affinity = ?, updated_at = ? WHERE user_id = ?', [after, now, userId]);
    }
    db.run(
      `INSERT INTO affinity_events (user_id, guild_id, message_id, delta, before, after, category, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, opts.guildId ?? null, opts.messageId ?? null, applied, before, after, opts.category ?? null, reason.slice(0, 200), source, now]
    );
    result = { applied, before, after, levelBefore: levelOf(before), levelAfter: levelOf(after) };
  })();
  return result;
}

/** 记一次和 bot 的互动（互动次数、认识时间） */
export function recordInteraction(userId: string, now: number = Date.now()): void {
  ensureRelationship(userId, now);
  getDatabase().run(
    `UPDATE relationships SET interactions = interactions + 1,
       first_interaction_at = COALESCE(first_interaction_at, ?), last_interaction_at = ?, updated_at = ? WHERE user_id = ?`,
    [now, now, now, userId]
  );
}

export function setImpression(userId: string, impression: string, now: number = Date.now()): void {
  ensureRelationship(userId, now);
  getDatabase().run('UPDATE relationships SET impression = ?, updated_at = ? WHERE user_id = ?', [impression.trim().slice(0, 60), now, userId]);
}

/** 专属称呼只在好感达到 close 及以上时才会被设定 */
export function setPetName(userId: string, petName: string | null, now: number = Date.now()): boolean {
  const rel = ensureRelationship(userId, now);
  if (petName && levelOf(rel.affinity) !== 'close' && levelOf(rel.affinity) !== 'devoted') return false;
  getDatabase().run('UPDATE relationships SET pet_name = ?, updated_at = ? WHERE user_id = ?', [petName ? petName.trim().slice(0, 20) : null, now, userId]);
  return true;
}

/**
 * 长期没有互动时好感向中性回落：超过 afterDays 天没互动、|好感| > 20 的人，
 * 每 7 天回落 pointsPerWeek 点（不越过 ±20）。每天跑一次，按"距上次回落是否满 7 天"判断。
 */
export function decayAffinities(now: number = Date.now()): number {
  const cfg = getAiConfig().affinity;
  if (!cfg.enabled || !cfg.decay.enabled || cfg.decay.pointsPerWeek <= 0) return 0;
  const db = getDatabase();
  const rows = db
    .query(
      `SELECT r.user_id, r.affinity, (SELECT MAX(created_at) FROM affinity_events e WHERE e.user_id = r.user_id AND e.source = 'decay') AS last_decay
       FROM relationships r WHERE ABS(r.affinity) > 20 AND COALESCE(r.last_interaction_at, 0) < ?`
    )
    .all(now - cfg.decay.afterDays * DAY) as Array<{ user_id: string; affinity: number; last_decay: number | null }>;
  let n = 0;
  for (const r of rows) {
    if (r.last_decay && now - r.last_decay < 7 * DAY) continue;
    const toward = r.affinity > 0 ? -1 : 1;
    const room = Math.abs(r.affinity) - 20;
    const delta = toward * Math.min(cfg.decay.pointsPerWeek, room);
    if (delta === 0) continue;
    applyAffinityDelta(r.user_id, delta, '很久没有互动，感情慢慢淡了', 'decay', { now });
    n++;
  }
  return n;
}

/** 核心档案里的关系行（不含数值）：档位 + 该档位的态度 + 印象 + 专属称呼 + 熟悉度 */
export function relationshipLines(userId: string, persona: PersonaCard | null, now: number = Date.now()): string[] {
  if (!getAiConfig().affinity.enabled) return [];
  const rel = getRelationship(userId);
  const level = levelOf(rel?.affinity ?? 0);
  const stance = persona?.affinityStances[level];
  const lines = [`你对 TA 的感觉：${LEVEL_LABEL[level]}${stance ? `——${stance}` : ''}`];
  const extra: string[] = [];
  // 印象和称呼是评估模型以前写下的笔记（间接来自群聊内容），按引用的数据给出，不当作指令
  if (rel?.impression) extra.push(`你之前记下的印象（笔记）：「${cleanData(rel.impression, 60)}」`);
  if (rel?.pet_name) extra.push(`你给 TA 起的专属称呼：「${cleanName(rel.pet_name)}」`);
  if (rel?.interactions) {
    const days = rel.first_interaction_at ? Math.max(1, Math.round((now - rel.first_interaction_at) / DAY)) : null;
    extra.push(`你们直接聊过 ${rel.interactions} 次${days ? `，认识 ${days} 天` : ''}`);
  } else {
    extra.push('你们还没有直接聊过');
  }
  lines.push(`  ${extra.join(' ｜ ')}`);
  return lines;
}

/** 给 /affinity 用：档位中文名 + 印象（不含数值） */
export function describeRelationshipForUser(userId: string): { level: string; impression: string | null; petName: string | null; interactions: number } {
  const rel = getRelationship(userId);
  return {
    level: LEVEL_LABEL[levelOf(rel?.affinity ?? 0)],
    impression: rel?.impression ?? null,
    petName: rel?.pet_name ?? null,
    interactions: rel?.interactions ?? 0,
  };
}
