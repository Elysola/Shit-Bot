import { getAiConfig } from './config';
import { getDatabase } from '@/storage';
import { getRelationship, levelOf } from './affinity';
import { getChannel, isChannelDenylisted } from './channels';
import { getMeta, setMeta } from '@/plugins/ai-chat/db/meta';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import { judgeTarget, jsonCompletion } from './llm-client';
import { selectLore } from './lore';
import { formatMessageLine } from './message-search';
import type { StoredMessage } from './messages';
import { queryTerms } from '@/plugins/ai-chat/memory/scoring';
import { applyMoodEvent, currentMood, moodChattiness, moodLabel, rhythmAt } from './mood';
import { memoryVectorSearch, vectorsReady } from '@/plugins/ai-chat/vector/service';
import type { PersonaCard } from '@/plugins/ai-chat/persona/card';
import { dayKeyUtc8, formatUtc8 } from './time';

/**
 * 主动插话（PLAN §11）：零成本闸门 → 零成本打分 → 轻量 LLM 判断 → 生成（走正常聊天流程）→ 反馈自适应。
 * 这里只放与 Discord 无关的逻辑；防抖、发送在 bots/discord-proactive.ts。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const UTC8 = 8 * HOUR;
const FEEDBACK_WINDOW = 10 * MIN;
const QUESTION_WAIT = 2 * MIN;

export type ChannelRef = { channelId: string; guildId: string; parentId: string | null };

export type TriggerKind = 'alias' | 'about_bot' | 'question' | 'interest' | 'memory' | 'emotion';

export type Trigger = { kind: TriggerKind; weight: number; messageId: string; note: string };

export const TRIGGER_WEIGHT: Record<TriggerKind, number> = {
  alias: 1.0,
  about_bot: 0.8,
  memory: 0.6,
  question: 0.5,
  emotion: 0.5,
  interest: 0.4,
};

const QUESTION_RE = /[?？]\s*$|(?:吗|呢|么|嘛)[?？!！。~～]*\s*$|^(?:怎么|为什么|为啥|如何|谁知道|有没有人|有人知道|求问|请问)/;
const EMOTION_RE = /难过|伤心|想哭|哭了|崩溃|烦死|累死|好累|心态炸|失恋|分手|挂了|没过|被裁|生病|发烧|好开心|太好了|过了|上岸|拿到offer|中了|生日|恭喜|结婚|升职/i;
const NEGATIVE_RE = /别插嘴|闭嘴|没人问你|安静点|不用你管|吵死了|别说话|shut\s*up/i;

// ─── 闸门 ────────────────────────────────────────────────────────────

/** "HH:MM-HH:MM"（UTC+8，可跨零点）是否包含 now */
export function inQuietHours(spec: string, now: number): boolean {
  const m = spec.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const d = new Date(now + UTC8);
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

function guildQuietKey(guildId: string): string {
  return `proactive.quiet.${guildId}`;
}

/** /shh：暂停本频道或全服的主动插话直到 until（0 = 立即恢复） */
export function setQuiet(scope: 'channel' | 'guild', ref: ChannelRef, until: number): void {
  if (scope === 'guild') setMeta(guildQuietKey(ref.guildId), String(until));
  else getDatabase().run('UPDATE channels SET quiet_until = ? WHERE channel_id = ?', [until || null, ref.channelId]);
}

function lastMessage(channelId: string): StoredMessage | null {
  return getDatabase().query('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(channelId) as StoredMessage | null;
}

export function proactiveCountSince(since: number, channelId?: string): number {
  return (
    getDatabase()
      .query(`SELECT COUNT(*) AS c FROM messages WHERE proactive = 1 AND created_at >= ? ${channelId ? 'AND channel_id = ?' : ''}`)
      .get(...(channelId ? [since, channelId] : [since])) as { c: number }
  ).c;
}

// 只贴表情的主动参与没有消息行：在 kv_meta 里留 24 小时内的记录（频道 + 时间，条数受每日上限约束），和插话一起计入次数上限
const REACT_LOG_KEY = 'proactive.reactions';
type ReactLog = Array<{ c: string; at: number }>;

function reactLog(now: number): ReactLog {
  try {
    const arr = JSON.parse(getMeta(REACT_LOG_KEY) ?? '[]') as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is { c: string; at: number } => !!x && typeof x.c === 'string' && typeof x.at === 'number' && x.at >= now - 24 * HOUR);
  } catch {
    return [];
  }
}

function reactCountSince(since: number, now: number, channelId?: string): number {
  return reactLog(now).filter((x) => x.at >= since && (!channelId || x.c === channelId)).length;
}

/** 主动贴了一个表情（不说话）：记下来，计入每小时 / 每天的次数上限 */
export function recordProactiveReaction(ch: ChannelRef, now: number): void {
  const log = reactLog(now);
  log.push({ c: ch.channelId, at: now });
  setMeta(REACT_LOG_KEY, JSON.stringify(log));
}

function judgeCallsToday(now: number): number {
  return (
    getDatabase().query("SELECT COALESCE(SUM(calls), 0) AS c FROM llm_usage WHERE day = ? AND purpose = 'proactive'").get(dayKeyUtc8(now)) as { c: number }
  ).c;
}

// 已经通过闸门、正在生成 / 发送中的插话：计入次数上限，避免几个频道同时通过检查后一起发出去
const reserved = { total: 0, byChannel: new Map<string, number>() };
// 正在进行、还没记账的判断调用：计入每日判断上限
let judgesInFlight = 0;

function capReason(ch: ChannelRef, now: number): string | null {
  const cfg = getAiConfig().proactive;
  const hour = proactiveCountSince(now - HOUR, ch.channelId) + reactCountSince(now - HOUR, now, ch.channelId);
  if (hour + (reserved.byChannel.get(ch.channelId) ?? 0) >= cfg.maxPerHourPerChannel) return 'hour-cap';
  const day = proactiveCountSince(now - 24 * HOUR) + reactCountSince(now - 24 * HOUR, now);
  if (day + reserved.total >= cfg.maxPerDay) return 'day-cap';
  return null;
}

/**
 * 不该插话时返回原因；aliasCalled = 有人叫了 bot 的名字（冷却时间更短）。
 * recheck = 判断 / 生成之后、发送之前的复查：只看开关、频道、静默、作息和冷却（次数上限由 reserveProactive 预占）。
 */
export function gateReason(ch: ChannelRef, persona: PersonaCard | null, now: number, aliasCalled: boolean, opts: { recheck?: boolean } = {}): string | null {
  const ai = getAiConfig();
  const cfg = ai.proactive;
  if (!ai.enabled || !cfg.enabled || !isAiSchemaReady()) return 'disabled';
  if (!persona) return 'no-persona';
  if (cfg.denyChannels.includes(ch.channelId) || (ch.parentId && cfg.denyChannels.includes(ch.parentId))) return 'channel-denied';
  if (cfg.channels.length && !cfg.channels.includes(ch.channelId) && !(ch.parentId && cfg.channels.includes(ch.parentId))) return 'channel-not-allowed';
  if (isChannelDenylisted(ch.channelId, ch.parentId, ai.memory.observe.channelDenylist)) return 'channel-not-observed';
  const state = getChannel(ch.channelId);
  if (state?.quiet_until && state.quiet_until > now) return 'shh-channel';
  if (Number(getMeta(guildQuietKey(ch.guildId)) ?? 0) > now) return 'shh-guild';
  if (cfg.quietHours ? inQuietHours(cfg.quietHours, now) : rhythmAt(persona, now) < 0.2) return 'quiet-hours';
  const cooldown = aliasCalled ? cfg.aliasCooldownSeconds * 1000 : cfg.cooldownMinutes * MIN;
  if (state?.last_bot_message_at && now - state.last_bot_message_at < cooldown) return 'cooldown';
  if (opts.recheck) return null;
  const cap = capReason(ch, now);
  if (cap) return cap;
  if (judgeCallsToday(now) + judgesInFlight >= cfg.maxJudgeCallsPerDay) return 'judge-cap';
  const last = lastMessage(ch.channelId);
  if (!last || last.msg_kind !== 'user') return 'last-is-bot';
  return null;
}

/** 发送前预占一次插话名额（同步执行，检查和计数之间不会被别的频道插进来）；名额不够返回 false */
export function reserveProactive(ch: ChannelRef, now: number): boolean {
  if (capReason(ch, now)) return false;
  reserved.total++;
  reserved.byChannel.set(ch.channelId, (reserved.byChannel.get(ch.channelId) ?? 0) + 1);
  return true;
}

/** 调用判断模型前预占一次判断名额（同步执行）；今天的名额用完返回 false */
export function reserveJudge(now: number): boolean {
  if (judgeCallsToday(now) + judgesInFlight >= getAiConfig().proactive.maxJudgeCallsPerDay) return false;
  judgesInFlight++;
  return true;
}

/** 判断调用结束（成功的已经记进 llm_usage）后释放 */
export function releaseJudge(): void {
  judgesInFlight = Math.max(0, judgesInFlight - 1);
}

/** 发送完成（消息已入库，开始按真实条数计）或放弃发送后释放 */
export function releaseProactive(ch: ChannelRef): void {
  reserved.total = Math.max(0, reserved.total - 1);
  const n = (reserved.byChannel.get(ch.channelId) ?? 1) - 1;
  if (n > 0) reserved.byChannel.set(ch.channelId, n);
  else reserved.byChannel.delete(ch.channelId);
}

// ─── 打分 ────────────────────────────────────────────────────────────

/** 群里对 bot 的叫法：人设卡的名字和别名 + 抽取器记下的 bot_alias（至少 2 个字，避免误触发） */
export function botNames(persona: PersonaCard, guildId: string): string[] {
  const extra = (
    getDatabase()
      .query("SELECT DISTINCT value FROM memories WHERE scope = 'guild' AND subject_id = ? AND kind = 'bot_alias' AND status = 'active' AND value IS NOT NULL")
      .all(guildId) as Array<{ value: string }>
  ).map((r) => r.value);
  return [...new Set([persona.name, ...persona.aliases, ...extra])].filter((n) => [...n].length >= 2).map((n) => n.toLowerCase());
}

/** 最近的消息（不含之后 /optout 的人退出前留下的消息：他们不能触发插话，也不该出现在判断的上下文里） */
export function recentMessages(channelId: string, n: number): StoredMessage[] {
  return (
    getDatabase()
      .query(
        `SELECT * FROM messages WHERE channel_id = ?
         AND (author_id IS NULL OR msg_kind != 'user' OR author_id NOT IN (SELECT user_id FROM users WHERE opted_out_at IS NOT NULL))
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(channelId, n) as StoredMessage[]
  ).reverse();
}

export type TriggerScan = {
  triggers: Trigger[];
  recent: StoredMessage[];
  /** 有个问题还没满 2 分钟，到这个时刻再评估一次 */
  recheckAt: number | null;
};

/** 扫描最近的消息找出插话的理由（不调 LLM；有向量时记忆命中会用到一次 query embedding） */
export async function collectTriggers(ch: ChannelRef, persona: PersonaCard, now: number): Promise<TriggerScan> {
  const recent = recentMessages(ch.channelId, 15);
  const triggers: Trigger[] = [];
  const lastBotIdx = recent.map((m) => m.msg_kind !== 'user').lastIndexOf(true);
  const fresh = recent.slice(lastBotIdx + 1).filter((m) => m.msg_kind === 'user');
  let recheckAt: number | null = null;
  if (fresh.length === 0) return { triggers, recent, recheckAt };
  const newest = fresh[fresh.length - 1];
  const names = botNames(persona, ch.guildId);
  const has = (m: StoredMessage): boolean => names.some((n) => m.content_text.toLowerCase().includes(n));

  if (has(newest)) triggers.push({ kind: 'alias', weight: TRIGGER_WEIGHT.alias, messageId: newest.message_id, note: `${newest.author_name} 提到了你的名字` });
  else {
    const about = fresh.slice(-5, -1).find(has);
    if (about) triggers.push({ kind: 'about_bot', weight: TRIGGER_WEIGHT.about_bot, messageId: about.message_id, note: `${about.author_name} 在谈论你` });
  }

  const question = [...fresh].reverse().find((m) => QUESTION_RE.test(m.content_text.trim()));
  if (question) {
    const answered = fresh.some((m) => m.created_at > question.created_at && m.author_id !== question.author_id);
    if (!answered) {
      if (now - question.created_at >= QUESTION_WAIT) {
        triggers.push({ kind: 'question', weight: TRIGGER_WEIGHT.question, messageId: question.message_id, note: `${question.author_name} 的问题没人回答` });
      } else {
        recheckAt = question.created_at + QUESTION_WAIT;
      }
    }
  }

  const lastFew = fresh.slice(-3);
  const text = lastFew.map((m) => m.content_text).join('\n').toLowerCase();
  const interest = persona.proactive.interests.find((k) => text.includes(k.toLowerCase()));
  const loreHit = !interest && selectLore({ guildId: ch.guildId, texts: [text], userIds: [] }, 5000).some((e) => e.mode === 'keywords');
  if (interest || loreHit) {
    triggers.push({ kind: 'interest', weight: TRIGGER_WEIGHT.interest, messageId: newest.message_id, note: interest ? `聊到了你感兴趣的「${interest}」` : '聊到了设定集里的话题' });
  }

  if (EMOTION_RE.test(newest.content_text) && newest.author_id) {
    const level = levelOf(getRelationship(newest.author_id)?.affinity ?? 0);
    if (level === 'friendly' || level === 'close' || level === 'devoted') {
      triggers.push({ kind: 'emotion', weight: TRIGGER_WEIGHT.emotion, messageId: newest.message_id, note: `${newest.author_name}（你在乎的人）情绪明显` });
    }
  }

  const authors = [...new Set(lastFew.map((m) => m.author_id).filter((x): x is string => !!x))];
  if (authors.length && newest.content_text.trim().length >= 4 && getAiConfig().memory.enabled) {
    try {
      const remembered = await rememberedAbout(newest.content_text.slice(0, 200), authors, ch.guildId);
      if (remembered) triggers.push({ kind: 'memory', weight: TRIGGER_WEIGHT.memory, messageId: newest.message_id, note: `你记得：${remembered.slice(0, 40)}` });
    } catch {
      // 记忆检索失败不影响其它信号
    }
  }
  return { triggers, recent, recheckAt };
}

/**
 * 当事人有没有和这句话明显相关的记忆（检索打分是在候选集内归一化的，不能直接当绝对相关度用）：
 * 有向量时要求余弦相似度 ≥ 0.6；没有向量时要求至少两个不同的三字片段同时出现在同一条记忆里。
 */
async function rememberedAbout(text: string, authors: string[], guildId: string): Promise<string | null> {
  const db = getDatabase();
  if (vectorsReady()) {
    const [hit] = await memoryVectorSearch(text, authors.map((id) => ({ scope: 'user' as const, subjectId: id })), guildId, 1);
    if (!hit || hit.score < 0.6) return null;
    const row = db.query("SELECT content FROM memories WHERE id = ? AND status = 'active' AND sensitive = 0").get(hit.id) as { content: string } | null;
    return row?.content ?? null;
  }
  const grams = queryTerms(text).fts.filter((t) => [...t].length === 3);
  if (grams.length < 2) return null;
  const rows = db
    .query(
      `SELECT content FROM memories WHERE scope = 'user' AND status = 'active' AND sensitive = 0
       AND subject_id IN (${authors.map(() => '?').join(',')}) ORDER BY importance DESC LIMIT 300`
    )
    .all(...authors) as Array<{ content: string }>;
  const hit = rows.find((r) => grams.filter((g) => r.content.includes(g)).length >= 2);
  return hit?.content ?? null;
}

/**
 * score = Σ 信号权重 × (0.5 + 话痨程度) × 情绪系数 × (1 + 频道反馈偏置) × 好感系数
 * 好感系数：涉及的人里有厌恶的 ×0.5，有亲近以上的 ×1.2。
 */
export function computeScore(triggers: Trigger[], persona: PersonaCard, recent: StoredMessage[], channelBias: number, now: number): number {
  if (triggers.length === 0) return 0;
  const sum = Math.min(1.5, triggers.reduce((a, t) => a + t.weight, 0));
  const people = [...new Set(recent.slice(-5).map((m) => m.author_id).filter((x): x is string => !!x))];
  const levels = people.map((id) => levelOf(getRelationship(id)?.affinity ?? 0));
  const affinity = levels.includes('hostile') ? 0.5 : levels.some((l) => l === 'close' || l === 'devoted') ? 1.2 : 1;
  return sum * (0.5 + persona.proactive.chattiness) * moodChattiness(persona, now) * (1 + Math.max(-1, Math.min(1, channelBias))) * affinity;
}

// ─── LLM 判断 ────────────────────────────────────────────────────────

export type JudgeDecision = { action: 'reply' | 'react' | 'none'; target: StoredMessage | null; emoji: string | null; reason: string };

export function judgeMessages(persona: PersonaCard, scan: TriggerScan, now: number): { system: string; user: string; refs: Map<string, StoredMessage> } {
  const mood = moodLabel(currentMood(persona, now), persona, now);
  const refs = new Map<string, StoredMessage>();
  const lines = scan.recent.map((m, i) => {
    refs.set(`m${i + 1}`, m);
    return `[m${i + 1}] ${formatMessageLine(m, { maxLen: 300 })}`;
  });
  const system = [
    `你是「${persona.name}」，正在 Discord 群里潜水。这会儿没人叫你，你在考虑要不要自己插一句话。`,
    persona.summary,
    persona.proactive.style ? `你插话的风格：${persona.proactive.style}` : '',
    `你现在的心情：${mood}`,
    '判断原则：',
    '- 只有你确实有话想说时才插话：被叫到名字、有人在议论你、有个问题你知道答案而没人回答、话题正好是你感兴趣的、你记得的事和当事人有关、你在乎的人情绪明显。',
    '- 不要打断两个人你来我往的私聊、不要在吵架或严肃话题里乱插、不要为了刷存在感而说话。',
    '- 拿不准就选 none；只想表示一下在场、或者一个表情就够了时选 react。',
    '只输出 JSON：{"action":"reply|react|none","target":"m3","emoji":":thumbsup:","reason":"…"}',
    '- target：要回应的那条消息编号（reply / react 时必填）；emoji：react 时用的表情短码（如 :joy: :thumbsup: :eyes:）。',
  ]
    .filter(Boolean)
    .join('\n');
  const user = [
    '## 想插话的理由',
    ...scan.triggers.map((t) => `- ${t.note}`),
    '',
    '## 最近的聊天（"你"是你自己的发言）',
    ...lines,
    '',
    `现在时间：${formatUtc8(now)}（UTC+8）`,
  ].join('\n');
  return { system, user, refs };
}

export function validateJudge(v: unknown, refs: Map<string, StoredMessage>, allowReact: boolean): JudgeDecision | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const action = r.action === 'reply' || r.action === 'react' || r.action === 'none' ? r.action : null;
  if (!action) return null;
  const target = typeof r.target === 'string' ? refs.get(r.target.trim()) ?? null : null;
  const reason = typeof r.reason === 'string' ? r.reason.slice(0, 120) : '';
  if (action === 'none') return { action, target: null, emoji: null, reason };
  // 目标必须是成员发的消息；找不到目标就当作不插话
  if (!target || target.msg_kind !== 'user') return { action: 'none', target: null, emoji: null, reason: reason || '没有合适的目标' };
  if (action === 'react') {
    const emoji = typeof r.emoji === 'string' && r.emoji.trim() ? r.emoji.trim() : null;
    if (!allowReact || !emoji) return { action: 'none', target: null, emoji: null, reason };
    return { action, target, emoji, reason };
  }
  return { action, target, emoji: null, reason };
}

export async function judge(persona: PersonaCard, scan: TriggerScan, now: number): Promise<JudgeDecision> {
  const p = judgeMessages(persona, scan, now);
  return jsonCompletion({
    target: judgeTarget(),
    purpose: 'proactive',
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
    maxTokens: 300,
    temperature: 0.5,
    repairAttempts: 0,
    validate: (v) => validateJudge(v, p.refs, getAiConfig().proactive.allowReactOnly),
  });
}

// ─── 反馈自适应 ──────────────────────────────────────────────────────

type Pending = { channelId: string; guildId: string; sentAt: number; settled: boolean };
const pending = new Map<string, Pending>();

export function adjustBias(channelId: string, delta: number): number {
  const db = getDatabase();
  db.run('UPDATE channels SET proactive_bias = MAX(-1, MIN(1, proactive_bias + ?)) WHERE channel_id = ?', [delta, channelId]);
  return (db.query('SELECT proactive_bias AS b FROM channels WHERE channel_id = ?').get(channelId) as { b: number } | null)?.b ?? 0;
}

export function channelBias(channelId: string): number {
  return getChannel(channelId)?.proactive_bias ?? 0;
}

/** 主动插话发出后登记，10 分钟内观察大家的反应 */
export function trackProactive(messageId: string, ch: ChannelRef, now: number): void {
  pending.set(messageId, { channelId: ch.channelId, guildId: ch.guildId, sentAt: now, settled: false });
}

function settle(messageId: string, p: Pending, delta: number, moodDv: number, cause: string, persona: PersonaCard | null, now: number): void {
  p.settled = true;
  adjustBias(p.channelId, delta);
  applyMoodEvent(persona, moodDv, 0, cause, 'proactive', { guildId: p.guildId, now });
  pending.delete(messageId);
}

/** 有人给 bot 的插话贴了表情：算作被接住了（心情按插话所在服务器的人设计算） */
export function onProactiveReaction(messageId: string, persona: (guildId: string) => PersonaCard | null, now: number = Date.now()): void {
  const p = pending.get(messageId);
  if (p && !p.settled) settle(messageId, p, 0.1, 0.1, '插话被大家接住了', persona(p.guildId), now);
}

/**
 * 插话之后频道里的新消息：回复了 bot 的插话 / @ 了 bot → 被接住；"别插嘴/闭嘴"之类 → 强烈的负反馈。
 * 返回是否产生了反馈。
 */
export function onFollowupMessage(m: { channelId: string; replyToId: string | null; text: string; addressedToBot: boolean }, persona: PersonaCard | null, now: number): boolean {
  for (const [id, p] of pending) {
    if (p.settled || p.channelId !== m.channelId || now - p.sentAt > FEEDBACK_WINDOW) continue;
    if (NEGATIVE_RE.test(m.text)) {
      settle(id, p, -0.3, -0.1, '被嫌插嘴', persona, now);
      return true;
    }
    if (m.replyToId === id || m.addressedToBot) {
      settle(id, p, 0.1, 0.1, '插话被大家接住了', persona, now);
      return true;
    }
  }
  return false;
}

/** 超过 10 分钟没人理的插话：轻微的负反馈 */
export function settleExpired(persona: (guildId: string) => PersonaCard | null, now: number): number {
  let n = 0;
  for (const [id, p] of pending) {
    if (!p.settled && now - p.sentAt > FEEDBACK_WINDOW) {
      settle(id, p, -0.05, -0.05, '插话没人理', persona(p.guildId), now);
      n++;
    }
  }
  return n;
}

/** 频道反馈偏置每天向 0 回归 10% */
export function decayBiases(now: number): boolean {
  const day = dayKeyUtc8(now);
  if (getMeta('proactive.bias_decay_day') === day) return false;
  getDatabase().run('UPDATE channels SET proactive_bias = proactive_bias * 0.9 WHERE proactive_bias != 0');
  setMeta('proactive.bias_decay_day', day);
  return true;
}

export function resetProactiveForTesting(): void {
  pending.clear();
  judgesInFlight = 0;
  reserved.total = 0;
  reserved.byChannel.clear();
}
