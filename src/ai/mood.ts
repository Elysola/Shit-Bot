import { getConfig } from '../config';
import { getDatabase } from '../storage';
import { getRelationship, levelOf } from './affinity';
import { isAiSchemaReady } from './db/schema';
import type { MoodLabel, PersonaCard } from './persona/card';
import { formatUtc8 } from './time';

/**
 * 情绪（PLAN §10）：效价 valence（-1 难过 … +1 开心）× 唤醒度 arousal（0 困倦 … 1 兴奋），按"灵魂"全局一份。
 * 不需要定时任务：读取时按时间解析计算衰减——效价向人设基线回归，唤醒度向 24 小时精力曲线回归。
 */

export type MoodState = { valence: number; arousal: number; cause: string | null; updatedAt: number };

export type MoodSource = 'interaction' | 'atmosphere' | 'proactive' | 'observed' | 'admin';

const SOUL = 'default';
const UTC8 = 8 * 3600_000;
const HOUR = 3600_000;

/** 各来源单次扰动的上限 [dv, da] */
const LIMITS: Record<MoodSource, [number, number]> = {
  interaction: [0.3, 0.2],
  atmosphere: [0.1, 0.1],
  proactive: [0.1, 0.05],
  observed: [0.1, 0.05],
  admin: [1, 1],
};

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** 某一时刻（UTC+8）人设精力曲线上的值：相邻两个整点之间按分钟线性插值 */
export function rhythmAt(persona: PersonaCard | null, now: number): number {
  if (!persona) return 0.5;
  const d = new Date(now + UTC8);
  const h = d.getUTCHours();
  const frac = d.getUTCMinutes() / 60;
  const r = persona.mood.rhythm;
  return r[h] + (r[(h + 1) % 24] - r[h]) * frac;
}

function baseline(persona: PersonaCard | null): { valence: number; arousal: number } {
  return persona?.mood.baseline ?? { valence: 0.1, arousal: 0.5 };
}

function loadRaw(): MoodState | null {
  if (!isAiSchemaReady()) return null;
  const row = getDatabase().query('SELECT valence, arousal, cause, updated_at FROM mood_state WHERE soul_id = ?').get(SOUL) as
    | { valence: number; arousal: number; cause: string | null; updated_at: number }
    | null;
  return row ? { valence: row.valence, arousal: row.arousal, cause: row.cause, updatedAt: row.updated_at } : null;
}

/** 当前心情（已按时间衰减）；还没有任何记录时就是人设基线 + 当前作息 */
export function currentMood(persona: PersonaCard | null, now: number = Date.now()): MoodState {
  const cfg = getConfig().ai.mood;
  const base = baseline(persona);
  const target = rhythmAt(persona, now);
  const raw = loadRaw();
  if (!raw) return { valence: base.valence, arousal: target, cause: null, updatedAt: now };
  const dt = Math.max(0, now - raw.updatedAt);
  const kv = Math.pow(0.5, dt / (cfg.valenceHalfLifeHours * HOUR));
  const ka = Math.pow(0.5, dt / (cfg.arousalHalfLifeHours * HOUR));
  return {
    valence: base.valence + (raw.valence - base.valence) * kv,
    arousal: target + (raw.arousal - target) * ka,
    // 原因随着情绪回落逐渐失效：效价偏离基线不到 0.08 时不再提原因
    cause: Math.abs((raw.valence - base.valence) * kv) >= 0.08 ? raw.cause : null,
    updatedAt: now,
  };
}

/** 两个坐标 → 心情标签（PLAN §10.1） */
export function moodLabel(state: MoodState, persona: PersonaCard | null, now: number = Date.now()): MoodLabel {
  const { valence: v, arousal: a } = state;
  if (v > 0.4 && a > 0.6) return '兴奋';
  if (v > 0.3) return '开心';
  if (v < -0.3 && a > 0.5) return '烦躁';
  if (v < -0.3) return '低落';
  if (a < 0.2 && rhythmAt(persona, now) < 0.3) return '困';
  if (a < 0.3) return '无聊';
  return '平静';
}

/** 单个用户最近一小时对效价的累计影响 */
function userImpactLastHour(userId: string, now: number): number {
  const row = getDatabase()
    .query('SELECT COALESCE(SUM(ABS(dv)), 0) AS s FROM mood_events WHERE user_id = ? AND created_at >= ?')
    .get(userId, now - HOUR) as { s: number };
  return row.s;
}

/**
 * 施加一次情绪扰动：先按时间衰减得到当前值，再加上限幅后的 (dv, da)。
 * 挚友（devoted）引起的变化 ×1.5；同一个人每小时的累计影响不超过 maxUserImpactPerHour。
 */
export function applyMoodEvent(
  persona: PersonaCard | null,
  rawDv: number,
  rawDa: number,
  cause: string,
  source: MoodSource,
  opts: { userId?: string | null; guildId?: string | null; now?: number } = {}
): MoodState | null {
  const cfg = getConfig().ai.mood;
  if (!cfg.enabled || !isAiSchemaReady()) return null;
  const now = opts.now ?? Date.now();
  const [lv, la] = LIMITS[source];
  let dv = clamp(Number(rawDv) || 0, -lv, lv);
  let da = clamp(Number(rawDa) || 0, -la, la);
  if (opts.userId) {
    const rel = getRelationship(opts.userId);
    if (rel && levelOf(rel.affinity) === 'devoted') {
      dv *= 1.5;
      da *= 1.5;
    }
    const room = Math.max(0, cfg.maxUserImpactPerHour - userImpactLastHour(opts.userId, now));
    if (Math.abs(dv) > room) dv = Math.sign(dv) * room;
  }
  const cur = currentMood(persona, now);
  const next: MoodState = {
    valence: clamp(cur.valence + dv, -1, 1),
    arousal: clamp(cur.arousal + da, 0, 1),
    cause: Math.abs(dv) >= 0.05 ? cause.slice(0, 60) : cur.cause,
    updatedAt: now,
  };
  const db = getDatabase();
  db.transaction(() => {
    db.run(
      `INSERT INTO mood_state (soul_id, valence, arousal, cause, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(soul_id) DO UPDATE SET valence = excluded.valence, arousal = excluded.arousal, cause = excluded.cause, updated_at = excluded.updated_at`,
      [SOUL, next.valence, next.arousal, next.cause, now]
    );
    db.run('INSERT INTO mood_events (dv, da, cause, source, user_id, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      dv,
      da,
      cause.slice(0, 120),
      source,
      opts.userId ?? null,
      opts.guildId ?? null,
      now,
    ]);
  })();
  return next;
}

/** 自我核心档案里的心情行：标签 + 原因 + 该心情下的说话方式（不含数值） */
export function moodLines(persona: PersonaCard | null, now: number = Date.now()): string[] {
  if (!getConfig().ai.mood.enabled || !isAiSchemaReady()) return [];
  const state = currentMood(persona, now);
  const label = moodLabel(state, persona, now);
  const cause = state.cause ?? (label === '困' ? `现在是 ${formatUtc8(now).slice(11, 16)}，正犯困` : null);
  const lines = [`你现在的心情：${label}${cause ? `（${cause}）` : ''}`];
  const style = persona?.mood.styles[label];
  if (style && label !== '平静') lines.push(`  这种心情下：${style}。但该答对的照样答对，心情不影响内容的正确性。`);
  return lines;
}

/** 主动插话用的情绪系数：唤醒度越高越想说话，困的时候基本不插话 */
export function moodChattiness(persona: PersonaCard | null, now: number = Date.now()): number {
  if (!getConfig().ai.mood.enabled || !isAiSchemaReady()) return 1;
  const state = currentMood(persona, now);
  const factor = 0.5 + state.arousal;
  return moodLabel(state, persona, now) === '困' ? factor * 0.2 : factor;
}
