import { logger } from '@/logger';
import { getAiConfig } from '@/plugins/ai-chat/config';
import { getDatabase } from '@/storage';
import { SLOT_WHITELIST } from '@/plugins/ai-chat/db/schema';
import { ForgetChangedError, assertNoForgetSince, forgetEpoch } from '@/plugins/ai-chat/forget-guard';
import { getUser, isOptedOut, listOptedOutUserIds, userExists } from '@/plugins/ai-chat/identity';
import { extractorTarget, getTokensUsedToday, jsonCompletion, type ChatMessage, type ContentPart } from '@/plugins/ai-chat/llm-client';
import { parseAttachments, parseStoredMentions, type StoredMessage } from '@/plugins/ai-chat/messages';
import { personaForGuild } from '@/plugins/ai-chat/persona/loader';
import { formatUtc8 } from '@/plugins/ai-chat/time';
import { fetchImageAsDataUri } from '@/plugins/ai-chat/websearch';
import { BudgetExceededError, MAX_ATTEMPTS, PRIORITY, PermanentJobError, enqueueJob, extractionAllowed, registerJobHandler, registerScheduler } from '@/plugins/ai-chat/worker';
import { memoryVectorSearch, vectorsReady } from '@/plugins/ai-chat/vector/service';
import { addressOf } from './dossier';
import { forbiddenReason, looksSensitive } from './sensitive';
import { emitAtmosphere, emitBotSentiment, type Atmosphere, type BotSentiment } from './signals';
import {
  SLOT_LABEL,
  addMemory,
  getMemory,
  isValidKind,
  parseParticipants,
  supersedeMemory,
  updateMemory,
  type MemoryKind,
  type MemoryRow,
  type MemoryScope,
} from './store';

/** 证据消息里的成员（共享记忆的参与者） */
function authorsOf(msgs: readonly StoredMessage[]): string[] {
  return msgs.filter((m) => m.msg_kind === 'user' && m.author_id).map((m) => m.author_id!);
}

const UTC8 = 8 * 3600_000;
const FRESH_IMG_MS = 23 * 3600_000;
const CONTEXT_MESSAGES = 10;
const MAX_CANDIDATES = 16;

// ─── 调度：哪些频道该抽取了 ────────────────────────────────────────────

/** 扫描有未处理消息的频道，按触发条件投递抽取任务；返回投递数 */
export function scheduleDueWindows(now: number = Date.now()): number {
  if (!extractionAllowed()) return 0;
  const cfg = getAiConfig().memory.extractor;
  const rows = getDatabase()
    .query(
      `SELECT channel_id, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest, MAX(source = 'live') AS live
       FROM messages WHERE extracted_at IS NULL GROUP BY channel_id`
    )
    .all() as Array<{ channel_id: string; n: number; oldest: number; newest: number; live: number }>;
  let queued = 0;
  for (const r of rows) {
    const due =
      r.n >= cfg.windowMessages ||
      (r.n >= 8 && now - r.newest >= cfg.idleSeconds * 1000) ||
      now - r.oldest >= cfg.maxWaitMinutes * 60_000;
    if (!due) continue;
    const isLive = r.live === 1 && now - r.newest < 3600_000;
    const id = enqueueJob(
      'extract_window',
      { channelId: r.channel_id },
      { priority: isLive ? PRIORITY.extractLive : PRIORITY.extractBackfill, dedupeKey: `extract:${r.channel_id}` },
      now
    );
    if (id) queued++;
  }
  return queued;
}

// ─── 窗口 ────────────────────────────────────────────────────────────

export type WindowPlan = {
  channelId: string;
  guildId: string;
  messages: StoredMessage[];
  context: StoredMessage[];
};

/**
 * 这次失败后任务就不再重试了（永久错误、或用完了重试次数）。预算用完、删除期间重做、功能被关掉都不算：
 * 它们之后能正常处理，窗口要留着。
 */
function givingUp(e: unknown, attemptsBefore: number): boolean {
  if (e instanceof BudgetExceededError || e instanceof ForgetChangedError || !getAiConfig().memory.enabled) return false;
  return e instanceof PermanentJobError || attemptsBefore + 1 >= MAX_ATTEMPTS;
}

/**
 * 跳过一个怎么都处理不了的窗口（比如上游一直以内容过滤拒绝）：标记为已处理，后面的消息照常提炼。
 * 不跳过的话，窗口总是取最早的未处理消息，调度会反复为同一个窗口建新任务，整个频道一直卡住。
 */
function skipWindow(channelId: string, e: unknown): void {
  const w = loadWindow(channelId, getAiConfig().memory.extractor.windowMessages);
  if (!w) return;
  markExtracted(
    w.messages.map((m) => m.id),
    Date.now()
  );
  logger.warn('Memory', `频道 ${channelId} 的一个窗口（${w.messages.length} 条消息）多次提炼失败，已跳过: ${(e as Error)?.message ?? e}`);
}

/** 取一个频道最早的 max 条未处理消息作为窗口，外加窗口之前 10 条作为上下文 */
export function loadWindow(channelId: string, max: number): WindowPlan | null {
  const db = getDatabase();
  const messages = db
    .query('SELECT * FROM messages WHERE channel_id = ? AND extracted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?')
    .all(channelId, max) as StoredMessage[];
  if (messages.length === 0) return null;
  const first = messages[0];
  const context = (
    db
      .query(
        `SELECT * FROM messages WHERE channel_id = ? AND extracted_at IS NOT NULL AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(channelId, first.created_at, first.created_at, first.id, CONTEXT_MESSAGES) as StoredMessage[]
  ).reverse();
  return { channelId, guildId: first.guild_id, messages, context };
}

export function markExtracted(ids: number[], now: number = Date.now()): void {
  if (ids.length === 0) return;
  getDatabase().run(`UPDATE messages SET extracted_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids]);
}

/** 窗口里有没有值得交给 LLM 的内容（全是"哈哈""+1"这类时直接跳过，不花 token） */
export function hasSubstance(msgs: StoredMessage[]): boolean {
  return msgs.some((m) => {
    if (m.msg_kind !== 'user') return false;
    if (parseAttachments(m.attachments).some((a) => a.type.startsWith('image'))) return true;
    return [...m.content_text.replace(/[\s\p{P}\p{S}]/gu, '')].length >= 4;
  });
}

// ─── 候选人 ──────────────────────────────────────────────────────────

export type Candidate = {
  id: string;
  label: string;
  /** 用来在文本里认出 TA 的名字（小写）：显示名、昵称、用户名、外号 */
  names: string[];
  role: 'author' | 'mentioned' | 'named';
};

function namesFor(userId: string, guildId: string, fallback: string): { label: string; names: string[] } {
  const db = getDatabase();
  const u = getUser(userId);
  const m = guildId
    ? (db.query('SELECT display_name, nickname FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
        | { display_name: string; nickname: string | null }
        | null)
    : null;
  const aliases = (
    db
      .query("SELECT value FROM memories WHERE scope = 'user' AND subject_id = ? AND kind = 'alias' AND status = 'active' AND value IS NOT NULL")
      .all(userId) as Array<{ value: string }>
  ).map((r) => r.value);
  const raw = [m?.display_name, m?.nickname, u?.global_name, u?.username, ...aliases, fallback];
  const names = [...new Set(raw.filter((x): x is string => !!x && [...x].length >= 2).map((x) => x.toLowerCase()))];
  return { label: m?.display_name ?? u?.global_name ?? u?.username ?? fallback, names };
}

/** 本窗口可能涉及的人：作者、被 @ 的人、被回复的人、名字或外号出现在文本里的成员（不含 bot 自己与 optout 用户） */
export function buildCandidates(w: WindowPlan, selfId: string | null, optedOut: ReadonlySet<string>): Candidate[] {
  const db = getDatabase();
  const out = new Map<string, Candidate>();
  const add = (id: string | null, role: Candidate['role'], fallbackName: string): void => {
    if (!id || id === selfId || optedOut.has(id) || out.has(id) || out.size >= MAX_CANDIDATES) return;
    const { label, names } = namesFor(id, w.guildId, fallbackName);
    out.set(id, { id, label, names, role });
  };
  for (const m of w.messages) if (m.msg_kind === 'user') add(m.author_id, 'author', m.author_name);
  for (const m of w.messages) {
    for (const ref of parseStoredMentions(m.mentions)) if (ref.t === 'user' && ref.id) add(ref.id, 'mentioned', ref.name ?? '');
    if (m.reply_to_id) {
      const parent = db.query('SELECT author_id, author_name, msg_kind FROM messages WHERE message_id = ?').get(m.reply_to_id) as
        | { author_id: string | null; author_name: string; msg_kind: string }
        | null;
      if (parent?.msg_kind === 'user') add(parent.author_id, 'mentioned', parent.author_name);
    }
  }
  if (w.guildId) {
    const text = w.messages.map((m) => m.content_text).join('\n').toLowerCase();
    const members = db
      .query(
        `SELECT gm.user_id, gm.display_name, gm.nickname, u.username, u.global_name FROM guild_members gm JOIN users u ON u.user_id = gm.user_id
         WHERE gm.guild_id = ? AND gm.left_at IS NULL AND u.is_self = 0 ORDER BY gm.last_seen_at DESC LIMIT 500`
      )
      .all(w.guildId) as Array<{ user_id: string; display_name: string; nickname: string | null; username: string; global_name: string | null }>;
    for (const mem of members) {
      const names = [mem.display_name, mem.nickname, mem.global_name, mem.username].filter((x): x is string => !!x && [...x].length >= 2);
      if (names.some((n) => text.includes(n.toLowerCase()))) add(mem.user_id, 'named', mem.display_name);
    }
    const aliasHits = db
      .query("SELECT DISTINCT subject_id, value FROM memories WHERE scope = 'user' AND kind = 'alias' AND status = 'active' AND value IS NOT NULL")
      .all() as Array<{ subject_id: string; value: string }>;
    for (const a of aliasHits) if ([...a.value].length >= 2 && text.includes(a.value.toLowerCase())) add(a.subject_id, 'named', a.value);
  }
  return [...out.values()];
}

// ─── 提示词 ──────────────────────────────────────────────────────────

function knownMemories(scope: MemoryScope, subjectId: string, limit: number): MemoryRow[] {
  return getDatabase()
    .query(
      `SELECT * FROM memories WHERE scope = ? AND subject_id = ? AND status = 'active' AND kind != 'episode'
       ORDER BY slot IS NOT NULL DESC, pinned DESC, updated_at DESC LIMIT ?`
    )
    .all(scope, subjectId, limit) as MemoryRow[];
}

function knownLine(m: MemoryRow): string {
  const kind = m.slot ? `slot ${SLOT_LABEL[m.slot] ?? m.slot}` : m.kind;
  return `#${m.id} [${kind}] ${m.content}`;
}

function messageLine(ref: string, m: StoredMessage, imageRefs: string[]): string {
  const who = m.msg_kind === 'user' ? `${m.author_name}(${m.author_id ?? '?'})` : `【你】${m.author_name}`;
  const img = imageRefs.length ? ` [${imageRefs.join(' ')}]` : '';
  return `[${ref}] ${formatUtc8(m.created_at).slice(5, 16)} ${who}: ${m.content_text.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 600)}${img}`;
}

export function extractionSystemPrompt(personaName: string, aliases: string[], memoryFocus: string, optedOut: string[]): string {
  const slots = SLOT_WHITELIST.map((s) => `${s}(${SLOT_LABEL[s] ?? s})`).join('、');
  return [
    `你是「${personaName}」的记忆整理员。任务：阅读一段 Discord 群聊记录，把其中值得长期记住的信息整理成结构化的记忆。`,
    memoryFocus ? `这个角色特别在意：${memoryFocus}` : '',
    '',
    '规则：',
    '1. 只记聊天里明确出现的信息，不推测、不编造。每条都必须给出证据消息编号 evidence（如 ["m3"]，只能引用 m 开头的编号）。',
    '2. 关于某个人（scope=user）：证据必须是 TA 本人说的，或者明确在说 TA（@了 TA、回复 TA、提到 TA 的名字或外号）。别人转述的也可以记，但 confidence 不超过 0.6。',
    '3. content 写一句能独立读懂的中文陈述，用名字/称呼指代人，不要写用户 ID；涉及时间的写清日期（如"10-29 要考六级"）。',
    '4. 能确定日期的事件/计划填 event_at（YYYY-MM-DD，UTC+8）；计划类填 valid_until（过了这天就没意义了）。',
    `5. 单值属性用 set_slot，slot 只能是：${slots}；value 写简短取值。preferred_name 只能来自本人明确的要求（"叫我 X 就行"）。`,
    `6. 别人对某人的叫法记为 kind=alias，value 写那个外号。群里对你（${personaName}${aliases.length ? `，也叫 ${aliases.join('、')}` : ''}）的叫法记为 scope=guild、kind=bot_alias，value 写叫法。`,
    '7. 已有记忆（带 #id）有补充或修正时用 update；情况变了（搬家、换工作、分手…）用 supersede；已经知道的不要重复记。没有新信息就输出空的 ops。',
    '8. 群里的公共信息（梗、规矩、群里发生的事、共同话题）记为 scope=guild，kind 用 lore/event/rule/meme/topic。两人之间的关系记为 scope=relation（subject、object 都填用户 ID），kind=relationship。',
    '9. 绝对不要记：密码、令牌、证件号、银行卡号、手机号、邮箱、详细住址。健康、性取向、宗教、政治、家庭隐私只记本人主动说的并设 sensitive=true；别人转述的这类信息不记。',
    optedOut.length ? `10. 以下用户已退出记录，不要为他们创建任何记忆：${optedOut.join('、')}` : '10. （无退出记录的用户）',
    '11. importance 1–10：日常闲聊 2–4；个人重要信息（工作、学业、重大事件、长期偏好）6–8；极其重要且长期有效 9–10。',
    '12. episode：用一两句话概括这段聊天在聊什么（谁、什么话题）；完全没有内容时给 null。',
    `13. bot_sentiment：有人在聊天里谈论你（${personaName}）、表达对你的态度时，给出 TA 的态度变化 delta（-3 到 +2）、原因和证据；没有就给 []。`,
    '14. atmosphere：这段聊天的整体气氛：tone（一个词，如 热闹/冷清/欢乐/争吵/伤感/平常）、valence（-1 到 1）、arousal（0 到 1）。',
    '15. 标为【你】的是你自己的发言：可以帮助理解上下文，但不要为你自己创建记忆。',
    '',
    '只输出一个 JSON 对象：{"episode": {"summary": "…", "importance": 3, "sensitive": false} 或 null, "ops": [...], "bot_sentiment": [...], "atmosphere": {...}}（episode 会被所有人看到，涉及隐私时设 sensitive=true 或给 null）',
    'ops 的格式：',
    '- {"op":"add","scope":"user|guild|relation","subject":"用户ID（scope=guild 时省略）","object":"用户ID（仅 relation）","kind":"…","content":"…","value":"…（可选）","importance":5,"confidence":0.9,"sensitive":false,"evidence":["m1"],"event_at":"YYYY-MM-DD（可选）","valid_until":"YYYY-MM-DD（可选）"}',
    '- {"op":"set_slot","subject":"用户ID","slot":"…","value":"…","content":"…","evidence":["m2"]}',
    '- {"op":"update","id":123,"content":"…（新的完整内容）","importance":6,"evidence":["m3"]}',
    '- {"op":"supersede","id":123,"content":"…（新情况）","value":"…（可选）","evidence":["m4"]}',
    'kind 取值：关于人 fact/preference/trait/event/plan/opinion/habit/alias；关于服务器 lore/event/rule/meme/topic/bot_alias；关系 relationship。',
    'bot_sentiment 的格式：{"user":"用户ID","delta":-2,"reason":"…","evidence":["m5"]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export type WindowRefs = { refs: Map<string, StoredMessage>; images: Array<{ label: string; url: string; ref: string }> };

/** 窗口消息编号 m1..mN；图片编号 图1..图K（只取新鲜的、成员发的） */
export function windowRefs(w: WindowPlan, maxImages: number, now: number): WindowRefs {
  const refs = new Map<string, StoredMessage>();
  const images: WindowRefs['images'] = [];
  w.messages.forEach((m, i) => {
    const ref = `m${i + 1}`;
    refs.set(ref, m);
    if (m.msg_kind !== 'user' || images.length >= maxImages) return;
    const fresh = m.attachments_at != null && now - m.attachments_at < FRESH_IMG_MS;
    if (!fresh) return;
    for (const a of parseAttachments(m.attachments)) {
      if (images.length >= maxImages) break;
      if (a.type.startsWith('image')) images.push({ label: `图${images.length + 1}`, url: a.url, ref });
    }
  });
  return { refs, images };
}

export function extractionUserPrompt(
  w: WindowPlan,
  candidates: Candidate[],
  refs: WindowRefs,
  now: number,
  /** 向量检索出的、与 TA 本窗口发言语义相近的已有记忆（帮助去重和更新） */
  related: Map<string, MemoryRow[]> = new Map()
): string {
  const parts: string[] = [];
  parts.push('## 可能涉及的人（subject/object 必须是这里的用户 ID）');
  if (candidates.length === 0) parts.push('（无）');
  for (const c of candidates) {
    const addr = c.id.startsWith('legacy:') ? null : addressOf(c.id, w.guildId || null);
    const aliasText = addr?.aliases.length ? ` ｜ 外号 ${addr.aliases.map((a) => a.value).join('、')}` : '';
    parts.push(`- 用户ID ${c.id} ｜ ${c.label}${addr ? ` ｜ 称呼 ${addr.address}` : ''}${aliasText}`);
    const known = knownMemories('user', c.id, c.role === 'author' ? 12 : 6);
    const seen = new Set(known.map((m) => m.id));
    for (const m of related.get(c.id) ?? []) {
      if (!seen.has(m.id)) {
        known.push(m);
        seen.add(m.id);
      }
    }
    if (known.length) parts.push(...known.map((m) => `    已知 ${knownLine(m)}`));
  }
  if (w.guildId) {
    const guildKnown = knownMemories('guild', w.guildId, 10);
    if (guildKnown.length) parts.push('', '## 服务器已知信息', ...guildKnown.map((m) => `- ${knownLine(m)}`));
  }
  if (w.context.length) {
    parts.push('', '## 上文（只帮助理解，不要从这里提取）');
    w.context.forEach((m, i) => parts.push(messageLine(`c${i + 1}`, m, [])));
  }
  parts.push('', '## 需要整理的聊天记录');
  for (const [ref, m] of refs.refs) {
    parts.push(messageLine(ref, m, refs.images.filter((img) => img.ref === ref).map((img) => img.label)));
  }
  if (refs.images.length) parts.push(`（附带的图片按顺序为：${refs.images.map((i) => `${i.label}（${i.ref}）`).join('、')}）`);
  parts.push('', `现在时间：${formatUtc8(now)}（UTC+8）`);
  return parts.join('\n');
}

// ─── 输出校验 ────────────────────────────────────────────────────────

export type RawOp = Record<string, unknown>;

export type ExtractionResult = {
  episode: { summary: string; importance: number; sensitive: boolean } | null;
  ops: RawOp[];
  botSentiment: Array<{ user: string; delta: number; reason: string; evidence: string[] }>;
  atmosphere: Atmosphere | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const n = (v: unknown, def: number): number => (Number.isFinite(Number(v)) ? Number(v) : def);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : typeof v === 'string' && v ? [v] : []);

/** 宽松地把模型输出收窄成 ExtractionResult；结构完全不对时返回 null（触发纠错重试） */
export function validateExtraction(v: unknown): ExtractionResult | null {
  if (!isObj(v)) return null;
  if (v.ops !== undefined && !Array.isArray(v.ops)) return null;
  const ep =
    isObj(v.episode) && s(v.episode.summary)
      ? { summary: s(v.episode.summary).slice(0, 300), importance: n(v.episode.importance, 3), sensitive: v.episode.sensitive === true }
      : null;
  const sentiment = Array.isArray(v.bot_sentiment)
    ? v.bot_sentiment.filter(isObj).map((b) => ({ user: s(b.user), delta: n(b.delta, 0), reason: s(b.reason).slice(0, 120), evidence: strs(b.evidence) }))
    : [];
  const atm = isObj(v.atmosphere)
    ? {
        tone: s(v.atmosphere.tone).slice(0, 10) || '平常',
        valence: Math.max(-1, Math.min(1, n(v.atmosphere.valence, 0))),
        arousal: Math.max(0, Math.min(1, n(v.atmosphere.arousal, 0.5))),
      }
    : null;
  return { episode: ep, ops: Array.isArray(v.ops) ? v.ops.filter(isObj) : [], botSentiment: sentiment, atmosphere: atm };
}

// ─── 应用 ────────────────────────────────────────────────────────────

export type ApplyStats = { added: number; updated: number; superseded: number; dropped: number; reasons: Record<string, number> };

/** "YYYY-MM-DD" → 当天 UTC+8 零点（endOfDay 时为 23:59:59） */
function parseDay(v: unknown, endOfDay = false): number | null {
  const m = s(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - UTC8;
  return Number.isFinite(base) ? base + (endOfDay ? 86400_000 - 1000 : 0) : null;
}

function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function isDuplicate(scope: MemoryScope, subjectId: string, content: string): boolean {
  const norm = normalize(content);
  if (!norm) return true;
  const rows = getDatabase()
    .query("SELECT content FROM memories WHERE scope = ? AND subject_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 300")
    .all(scope, subjectId) as Array<{ content: string }>;
  return rows.some((r) => {
    const other = normalize(r.content);
    return other === norm || (norm.length >= 6 && other.includes(norm));
  });
}

type ApplyContext = {
  w: WindowPlan;
  refs: Map<string, StoredMessage>;
  candidates: Map<string, Candidate>;
  now: number;
  stats: ApplyStats;
};

function drop(c: ApplyContext, reason: string): void {
  c.stats.dropped++;
  c.stats.reasons[reason] = (c.stats.reasons[reason] ?? 0) + 1;
}

function evidenceMessages(op: RawOp, c: ApplyContext): StoredMessage[] {
  return strs(op.evidence)
    .map((r) => c.refs.get(r.replace(/^#/, '')))
    .filter((m): m is StoredMessage => !!m);
}

/** 证据是否"关于"某人：本人说的、@了 TA、回复了 TA、或者文本里出现了 TA 的名字/外号 */
function aboutPerson(msg: StoredMessage, cand: Candidate): boolean {
  if (msg.author_id === cand.id) return true;
  if (parseStoredMentions(msg.mentions).some((m) => m.t === 'user' && m.id === cand.id)) return true;
  if (msg.reply_to_id) {
    const parent = getDatabase().query('SELECT author_id FROM messages WHERE message_id = ?').get(msg.reply_to_id) as { author_id: string | null } | null;
    if (parent?.author_id === cand.id) return true;
  }
  const text = msg.content_text.toLowerCase();
  return cand.names.some((nm) => text.includes(nm));
}

function resolveSubject(raw: unknown, c: ApplyContext): Candidate | null {
  const id = s(raw).replace(/^<@!?(\d+)>$/, '$1');
  if (c.candidates.has(id)) return c.candidates.get(id)!;
  const lower = id.toLowerCase().replace(/^@/, '');
  for (const cand of c.candidates.values()) if (cand.names.includes(lower)) return cand;
  return null;
}

/** 关于某人的一条 op 是否站得住：返回 [来源用户ID, 是否本人自述]；不成立返回 null */
function personEvidence(op: RawOp, cand: Candidate, c: ApplyContext): { source: string | null; selfReported: boolean; ids: string[] } | null {
  const ev = evidenceMessages(op, c);
  if (ev.length === 0) return null;
  const relevant = ev.filter((m) => aboutPerson(m, cand));
  if (relevant.length === 0) return null;
  const own = relevant.find((m) => m.author_id === cand.id);
  return { source: (own ?? relevant[0]).author_id, selfReported: !!own, ids: ev.map((m) => m.message_id) };
}

function applyAdd(op: RawOp, c: ApplyContext): void {
  const scope = s(op.scope) as MemoryScope;
  const kind = s(op.kind);
  const content = s(op.content).slice(0, 400);
  if (!content) return drop(c, 'empty');
  if (scope !== 'user' && scope !== 'guild' && scope !== 'relation') return drop(c, 'bad-scope');
  if (!isValidKind(scope, kind) || kind === 'episode') return drop(c, 'bad-kind');
  const importance = Math.max(1, Math.min(10, Math.round(n(op.importance, 5))));
  const eventAt = parseDay(op.event_at);
  const validUntil = parseDay(op.valid_until, true);
  const value = s(op.value).slice(0, 40) || null;
  // 取值字段（外号、slot 的值）会单独展示，和正文一起过隐私检查
  if (forbiddenReason(`${content} ${value ?? ''}`)) return drop(c, 'forbidden');

  if (scope === 'guild') {
    if (!c.w.guildId) return drop(c, 'no-guild');
    const ev = evidenceMessages(op, c);
    if (ev.length === 0) return drop(c, 'no-evidence');
    if (kind === 'bot_alias' && !value) return drop(c, 'alias-without-value');
    if (op.sensitive === true || looksSensitive(`${content} ${value ?? ''}`)) return drop(c, 'sensitive-guild');
    if (isDuplicate('guild', c.w.guildId, content)) return drop(c, 'duplicate');
    addMemory(
      {
        scope: 'guild',
        subjectId: c.w.guildId,
        guildId: c.w.guildId,
        kind: kind as MemoryKind,
        value,
        content,
        importance,
        confidence: Math.max(0, Math.min(1, n(op.confidence, 0.8))),
        origin: 'extractor',
        sourceUserId: ev[0].author_id,
        participants: authorsOf(ev),
        evidence: ev.map((m) => m.message_id),
        eventAt,
        validUntil,
      },
      c.now
    );
    c.stats.added++;
    return;
  }

  const subject = resolveSubject(op.subject, c);
  if (!subject) return drop(c, 'unknown-subject');
  const proof = personEvidence(op, subject, c);
  if (!proof) return drop(c, 'no-evidence');

  let object: Candidate | null = null;
  if (scope === 'relation') {
    object = resolveSubject(op.object, c);
    if (!object || object.id === subject.id) return drop(c, 'bad-object');
  }

  const sensitive = op.sensitive === true || looksSensitive(`${content} ${value ?? ''}`);
  if (sensitive && (!proof.selfReported || scope === 'relation')) return drop(c, 'sensitive-hearsay');
  if (kind === 'alias' && !value) return drop(c, 'alias-without-value');
  if (isDuplicate(scope, subject.id, content)) return drop(c, 'duplicate');

  let confidence = Math.max(0, Math.min(1, n(op.confidence, 0.8)));
  if (!proof.selfReported) confidence = Math.min(confidence, 0.6);

  addMemory(
    {
      scope,
      subjectId: subject.id,
      objectId: object?.id ?? null,
      guildId: c.w.guildId || null,
      kind: kind as MemoryKind,
      value,
      content,
      importance,
      confidence,
      sensitive,
      origin: 'extractor',
      sourceUserId: proof.source,
      evidence: proof.ids,
      eventAt,
      validUntil,
    },
    c.now
  );
  c.stats.added++;
}

function applySetSlot(op: RawOp, c: ApplyContext): void {
  const slot = s(op.slot);
  const value = s(op.value).slice(0, 40);
  if (!SLOT_WHITELIST.includes(slot)) return drop(c, 'bad-slot');
  if (!value) return drop(c, 'slot-without-value');
  const subject = resolveSubject(op.subject, c);
  if (!subject) return drop(c, 'unknown-subject');
  const proof = personEvidence(op, subject, c);
  if (!proof) return drop(c, 'no-evidence');
  if (slot === 'preferred_name' && !proof.selfReported) return drop(c, 'preferred-name-hearsay');
  const content = s(op.content).slice(0, 200) || `${SLOT_LABEL[slot] ?? slot}：${value}`;
  if (forbiddenReason(`${content} ${value}`)) return drop(c, 'forbidden');
  const sensitive = op.sensitive === true || slot === 'relationship_status' || slot === 'gender' || looksSensitive(`${content} ${value}`);
  if (sensitive && !proof.selfReported) return drop(c, 'sensitive-hearsay');
  const cur = getDatabase()
    .query("SELECT value FROM memories WHERE scope = 'user' AND subject_id = ? AND slot = ? AND status = 'active'")
    .get(subject.id, slot) as { value: string | null } | null;
  if (cur?.value && cur.value === value) return drop(c, 'duplicate');
  addMemory(
    {
      scope: 'user',
      subjectId: subject.id,
      guildId: c.w.guildId || null,
      kind: 'fact',
      slot,
      value,
      content,
      importance: Math.max(1, Math.min(10, Math.round(n(op.importance, 6)))),
      confidence: proof.selfReported ? 0.9 : 0.6,
      sensitive,
      origin: 'extractor',
      sourceUserId: proof.source,
      evidence: proof.ids,
    },
    c.now
  );
  c.stats.added++;
}

/** update / supersede 的目标必须存在、有效，并且属于本窗口涉及的主体 */
function editableTarget(op: RawOp, c: ApplyContext): MemoryRow | null {
  const row = getMemory(Math.trunc(n(op.id, 0)));
  if (!row || row.status !== 'active') return null;
  if (row.scope === 'guild') return row.subject_id === c.w.guildId ? row : null;
  if (row.scope === 'user') return c.candidates.has(row.subject_id) ? row : null;
  if (row.scope === 'relation') return c.candidates.has(row.subject_id) && !!row.object_id && c.candidates.has(row.object_id) ? row : null;
  return null;
}

function applyUpdate(op: RawOp, c: ApplyContext, supersede: boolean): void {
  const row = editableTarget(op, c);
  if (!row) return drop(c, 'bad-target');
  const ev = evidenceMessages(op, c);
  if (ev.length === 0) return drop(c, 'no-evidence');
  const content = s(op.content).slice(0, 400);
  if (!content) return drop(c, 'empty');
  const newValue = s(op.value).slice(0, 40);
  if (forbiddenReason(`${content} ${newValue}`)) return drop(c, 'forbidden');
  // 模型自己标了敏感也算（正则覆盖不了所有病名之类的说法）
  const sensitive =
    op.sensitive === true || !!row.sensitive || row.slot === 'gender' || row.slot === 'relationship_status' || looksSensitive(`${content} ${newValue}`);
  if (row.slot && !supersede && !newValue) return drop(c, 'slot-without-value');
  let selfReported = true;
  if (row.scope === 'user') {
    const cand = c.candidates.get(row.subject_id)!;
    if (!ev.some((m) => aboutPerson(m, cand))) return drop(c, 'no-evidence');
    selfReported = ev.some((m) => m.author_id === row.subject_id);
    if (sensitive && !selfReported) return drop(c, 'sensitive-hearsay');
    // 称呼只能由本人决定：取代旧称呼和 set_slot 一样要本人的发言作证据
    if (row.slot === 'preferred_name' && !selfReported) return drop(c, 'preferred-name-hearsay');
  } else if (sensitive) {
    return drop(c, 'sensitive-guild');
  }
  if (supersede) {
    supersedeMemory(
      row.id,
      {
        scope: row.scope,
        subjectId: row.subject_id,
        objectId: row.object_id,
        guildId: c.w.guildId || row.guild_id,
        kind: row.kind,
        slot: row.slot,
        value: newValue || (row.slot ? null : row.value),
        content,
        importance: op.importance !== undefined ? Math.round(n(op.importance, row.importance)) : row.importance,
        // 只有别人的转述作证据：和新增时一样按转述处理
        confidence: selfReported ? row.confidence : Math.min(row.confidence, 0.6),
        sensitive: !!row.sensitive || sensitive,
        origin: 'extractor',
        sourceUserId: ev[0].author_id,
        // 共享记忆的新版本延续旧版本的内容：参与者合并
        participants: row.scope === 'guild' || row.scope === 'self' ? [...parseParticipants(row.participants), ...authorsOf(ev)] : undefined,
        evidence: ev.map((m) => m.message_id),
        eventAt: parseDay(op.event_at),
        validUntil: parseDay(op.valid_until, true),
      },
      c.now
    );
    c.stats.superseded++;
  } else {
    updateMemory(
      row.id,
      {
        content,
        value: row.slot ? newValue : undefined,
        importance: op.importance !== undefined ? Math.round(n(op.importance, row.importance)) : undefined,
        // 补充后的内容变成敏感的：同步打上敏感标记（只在和本人聊天时使用）
        sensitive: sensitive || undefined,
        // 只有别人的转述作证据：来源改成说这话的人，置信度按转述处理
        ...(selfReported ? {} : { confidence: Math.min(row.confidence, 0.6), sourceUserId: ev[0].author_id }),
        addEvidence: ev.map((m) => m.message_id),
        addParticipants: row.scope === 'guild' || row.scope === 'self' ? authorsOf(ev) : undefined,
      },
      c.now
    );
    c.stats.updated++;
  }
}

/** 把一次抽取结果写入记忆库（调用方负责事务） */
export function applyExtraction(result: ExtractionResult, w: WindowPlan, refs: Map<string, StoredMessage>, candidates: Candidate[], now: number): ApplyStats {
  const stats: ApplyStats = { added: 0, updated: 0, superseded: 0, dropped: 0, reasons: {} };
  const c: ApplyContext = { w, refs, candidates: new Map(candidates.map((x) => [x.id, x])), now, stats };
  for (const op of result.ops) {
    try {
      switch (s(op.op)) {
        case 'add':
          applyAdd(op, c);
          break;
        case 'set_slot':
          applySetSlot(op, c);
          break;
        case 'update':
          applyUpdate(op, c, false);
          break;
        case 'supersede':
          applyUpdate(op, c, true);
          break;
        default:
          drop(c, 'bad-op');
      }
    } catch (e) {
      drop(c, `error:${(e as Error).message.slice(0, 40)}`);
    }
  }
  const episodeText = result.episode?.summary ?? '';
  if (result.episode && (result.episode.sensitive || forbiddenReason(episodeText) || looksSensitive(episodeText))) {
    drop(c, 'episode-private');
  } else if (result.episode && w.guildId) {
    // 证据：窗口里每个发言者各一条消息（成员在前）——摘要可能来自任何一个人的发言，
    // /forget-me 按证据认出"这条摘要有 TA 的份"，不能只记首尾两条
    const firstByAuthor = new Map<string, string>();
    for (const m of [...w.messages].sort((a, b) => Number(a.msg_kind !== 'user') - Number(b.msg_kind !== 'user'))) {
      const key = m.author_id ?? `name:${m.author_name}`;
      if (!firstByAuthor.has(key)) firstByAuthor.set(key, m.message_id);
    }
    addMemory(
      {
        scope: 'guild',
        subjectId: w.guildId,
        guildId: w.guildId,
        kind: 'episode',
        content: result.episode.summary,
        importance: Math.max(1, Math.min(6, Math.round(result.episode.importance))),
        origin: 'extractor',
        evidence: [...firstByAuthor.values()].slice(0, 20),
        participants: authorsOf(w.messages),
        eventAt: w.messages[w.messages.length - 1].created_at,
      },
      now
    );
  }
  return stats;
}

function sentimentEntries(result: ExtractionResult, refs: Map<string, StoredMessage>, candidates: Candidate[]): BotSentiment[] {
  const ids = new Set(candidates.map((x) => x.id));
  const out: BotSentiment[] = [];
  for (const b of result.botSentiment) {
    if (!ids.has(b.user) || b.delta === 0) continue;
    const ev = b.evidence.map((r) => refs.get(r)).find((m) => m?.author_id === b.user);
    if (!ev) continue;
    out.push({ userId: b.user, delta: Math.max(-3, Math.min(2, Math.round(b.delta))), reason: b.reason || '在群里谈论你', messageId: ev.message_id });
  }
  return out;
}

/** 向量化启用时：按每个作者在本窗口的发言，找出语义相近的已有记忆（失败就跳过，不影响抽取） */
async function relatedMemories(w: WindowPlan, candidates: Candidate[]): Promise<Map<string, MemoryRow[]>> {
  const out = new Map<string, MemoryRow[]>();
  if (!vectorsReady()) return out;
  for (const c of candidates.filter((x) => x.role === 'author')) {
    const text = w.messages
      .filter((m) => m.author_id === c.id)
      .map((m) => m.content_text)
      .join('\n')
      .slice(0, 500);
    if (!text.trim()) continue;
    try {
      const hits = await memoryVectorSearch(text, [{ scope: 'user', subjectId: c.id }], w.guildId || null, 6);
      const rows = hits.map((h) => getMemory(h.id)).filter((m): m is MemoryRow => !!m && m.status === 'active');
      if (rows.length) out.set(c.id, rows);
    } catch (e) {
      logger.warn('Extract', '查找相近记忆失败(跳过):', (e as Error).message);
      break;
    }
  }
  return out;
}

async function loadImages(images: WindowRefs['images']): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  const max = getAiConfig().maxImageBytes ?? 6 * 1024 * 1024;
  for (const img of images) {
    try {
      const { dataUri } = await fetchImageAsDataUri(img.url, max);
      parts.push({ type: 'text', text: `${img.label}（${img.ref}）：` }, { type: 'image_url', image_url: { url: dataUri } });
    } catch (e) {
      logger.warn('Extract', `图片 ${img.label} 下载失败(跳过): ${(e as Error).message}`);
    }
  }
  return parts;
}

/** 抽取任务：处理一个频道最早的一个窗口；处理完如果还有积压，会由调度器继续投递 */
export async function runExtractWindow(channelId: string, now: number = Date.now()): Promise<ApplyStats | null> {
  const ai = getAiConfig();
  if (!ai.memory.enabled) throw new PermanentJobError('记忆功能已关闭');
  const epoch = forgetEpoch();
  const w = loadWindow(channelId, ai.memory.extractor.windowMessages);
  if (!w) return null;
  const ids = w.messages.map((m) => m.id);
  if (!hasSubstance(w.messages)) {
    markExtracted(ids, now);
    return { added: 0, updated: 0, superseded: 0, dropped: 0, reasons: {} };
  }

  const optedOut = listOptedOutUserIds();
  const selfId = (getDatabase().query("SELECT value FROM kv_meta WHERE key = 'bot.user_id'").get() as { value: string } | null)?.value ?? null;
  // optout 用户自己的消息本来就不会入库；他们被别人提到时，这里也不会把他们列为候选人
  const candidates = buildCandidates(w, selfId, new Set(optedOut));
  const persona = personaForGuild(w.guildId || null);
  const refs = windowRefs(w, ai.memory.extractor.images ? ai.memory.extractor.maxImagesPerWindow : 0, now);
  const system = extractionSystemPrompt(persona?.name ?? 'bot', persona?.aliases ?? [], persona?.memoryFocus ?? '', optedOut);
  const userText = extractionUserPrompt(w, candidates, refs, now, await relatedMemories(w, candidates));
  const imageParts = refs.images.length ? await loadImages(refs.images) : [];
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: imageParts.length ? [{ type: 'text', text: userText }, ...imageParts] : userText },
  ];

  const result = await jsonCompletion({
    target: extractorTarget(),
    purpose: 'extract',
    messages,
    maxTokens: 3000,
    temperature: 0.2,
    timeoutMs: 120_000,
    validate: validateExtraction,
  });

  // 等模型期间有人 /forget-me：整个窗口稍后用删除后的数据重做（摘要、群记忆里都可能带着 TA）
  assertNoForgetSince(epoch);
  // 等模型的这段时间里可能有消息被删除、有人 /optout：只认仍在库里的消息和仍可记录的人
  const liveRefs = stillStored(refs.refs);
  const liveCandidates = candidates.filter((c) => userExists(c.id) && !isOptedOut(c.id));
  // 有消息在这期间被删掉时，整段摘要可能带着被删的内容，不再写入
  const applied = liveRefs === refs.refs ? result : { ...result, episode: null };

  let stats!: ApplyStats;
  getDatabase().transaction(() => {
    // 记忆的时间戳用提交时刻（不是任务开始时刻）：并发时画像的水位线不会把晚提交的结果当成已处理
    stats = applyExtraction(applied, w, liveRefs, liveCandidates, Date.now());
    markExtracted(ids, now);
  })();

  if (w.guildId) {
    const ctx = { guildId: w.guildId, channelId, at: w.messages[w.messages.length - 1].created_at };
    emitBotSentiment(sentimentEntries(result, liveRefs, liveCandidates), ctx);
    if (result.atmosphere && w.messages.some((m) => m.source === 'live')) emitAtmosphere(result.atmosphere, ctx);
  }

  const reasons = Object.entries(stats.reasons)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ');
  logger.info(
    'Extract', `#${getChannelLabel(channelId)} ${w.messages.length} 条 → 新增 ${stats.added} / 更新 ${stats.updated} / 取代 ${stats.superseded} / 丢弃 ${stats.dropped}${reasons ? `（${reasons}）` : ''}`
  );
  return stats;
}

function stillStored(refs: Map<string, StoredMessage>): Map<string, StoredMessage> {
  const ids = [...refs.values()].map((m) => m.message_id);
  if (ids.length === 0) return refs;
  const present = new Set(
    (getDatabase().query(`SELECT message_id FROM messages WHERE message_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ message_id: string }>).map(
      (r) => r.message_id
    )
  );
  if (present.size === ids.length) return refs;
  return new Map([...refs].filter(([, m]) => present.has(m.message_id)));
}

function getChannelLabel(channelId: string): string {
  const row = getDatabase().query('SELECT name FROM channels WHERE channel_id = ?').get(channelId) as { name: string | null } | null;
  return row?.name ?? channelId;
}

// 有积压时一个任务连续处理的最多窗口数（否则每 30 秒调度一次，大量历史要很久才能消化完）
const WINDOWS_PER_JOB = 5;

function backlogDue(channelId: string, now: number): boolean {
  const cfg = getAiConfig().memory.extractor;
  const r = getDatabase()
    .query('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM messages WHERE channel_id = ? AND extracted_at IS NULL')
    .get(channelId) as { n: number; oldest: number | null };
  return r.n >= cfg.windowMessages || (r.oldest !== null && now - r.oldest >= cfg.maxWaitMinutes * 60_000);
}

/** 注册任务处理器与调度器（启动时调用一次） */
export function registerExtraction(): void {
  registerJobHandler('extract_window', async (payload, job) => {
    const channelId = isObj(payload) ? s(payload.channelId) : '';
    if (!channelId) throw new PermanentJobError('缺少 channelId');
    const budget = getAiConfig().memory.extractor.dailyTokenBudget;
    for (let i = 0; i < WINDOWS_PER_JOB; i++) {
      // 执行期间配置可能被改成不提炼（比如关掉观察、开着总结）：剩下的窗口留到允许时再处理
      if (!extractionAllowed()) break;
      let stats: ApplyStats | null;
      try {
        stats = await runExtractWindow(channelId);
      } catch (e) {
        if (givingUp(e, job.attempts)) skipWindow(channelId, e);
        throw e;
      }
      if (!stats || !backlogDue(channelId, Date.now())) break;
      if (budget > 0 && getTokensUsedToday(['extract', 'profile', 'appraise']) >= budget) break;
    }
  });
  registerScheduler('extract-windows', 30_000, (now) => {
    scheduleDueWindows(now);
  });
}
