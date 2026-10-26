import { logger } from '@/logger';
import { getAiConfig } from '@/plugins/ai-chat/config';
import { getDatabase } from '@/storage';
import { assertNoForgetSince, forgetEpoch } from '@/plugins/ai-chat/forget-guard';
import { isOptedOut, userExists } from '@/plugins/ai-chat/identity';
import { extractorTarget, jsonCompletion } from '@/plugins/ai-chat/llm-client';
import { getPersona } from '@/plugins/ai-chat/persona/loader';
import { formatUtc8 } from '@/plugins/ai-chat/time';
import { PRIORITY, PermanentJobError, enqueueJob, registerJobHandler, registerScheduler } from '@/plugins/ai-chat/worker';
import { displayNameOf, identityLines } from './dossier';
import { forbiddenReason, looksSensitive } from './sensitive';
import { computeUserStats, describeStats, saveUserStats } from './stats';
import { addMemory, getMemory, KIND_LABEL, SLOT_LABEL, updateMemory, type MemoryRow, type MemoryScope } from './store';

const DAY = 86400_000;
const MAX_PER_TICK = 20;

type ProfileScope = Extract<MemoryScope, 'user' | 'guild' | 'self'>;

type ProfileRow = { summary: string; memory_watermark: number; generated_at: number };

function getProfile(scope: ProfileScope, subjectId: string): ProfileRow | null {
  return getDatabase().query('SELECT summary, memory_watermark, generated_at FROM profiles WHERE scope = ? AND subject_id = ?').get(scope, subjectId) as ProfileRow | null;
}

function saveProfile(scope: ProfileScope, subjectId: string, summary: string, watermark: number, model: string, now: number): void {
  getDatabase().run(
    `INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, subject_id) DO UPDATE SET summary = excluded.summary, memory_watermark = excluded.memory_watermark,
       model = excluded.model, generated_at = excluded.generated_at`,
    [scope, subjectId, summary, watermark, model, now]
  );
}

// ─── 调度 ────────────────────────────────────────────────────────────

type DueRow = { subject_id: string; total: number; changed: number; watermark: number | null; generated_at: number | null };

function dueSubjects(scope: ProfileScope): DueRow[] {
  return getDatabase()
    .query(
      `SELECT m.subject_id, COUNT(*) AS total,
              SUM(CASE WHEN m.updated_at > COALESCE(p.memory_watermark, 0) THEN 1 ELSE 0 END) AS changed,
              p.memory_watermark AS watermark, p.generated_at AS generated_at
       FROM memories m LEFT JOIN profiles p ON p.scope = m.scope AND p.subject_id = m.subject_id
       WHERE m.scope = ? AND m.status = 'active' AND m.subject_id NOT LIKE 'legacy:%'
         AND m.subject_id NOT IN (SELECT user_id FROM users WHERE opted_out_at IS NOT NULL)
       GROUP BY m.subject_id`
    )
    .all(scope) as DueRow[];
}

/**
 * 画像刷新条件（PLAN §7.3）：
 * - 用户：还没有画像且已有 ≥3 条记忆；或自上次以来新增/变更 ≥5 条；或有变化且距上次超过 7 天；
 * - 服务器：有变化且距上次超过 1 天（或还没有画像）；
 * - 自我：还没有画像且已有 ≥3 条；或新增/变更 ≥3 条。
 */
export function scheduleProfileRefresh(now: number = Date.now()): number {
  let queued = 0;
  const push = (scope: ProfileScope, subjectId: string): void => {
    if (queued >= MAX_PER_TICK) return;
    if (enqueueJob('refresh_profile', { scope, subjectId }, { priority: PRIORITY.profile, dedupeKey: `profile:${scope}:${subjectId}` }, now)) queued++;
  };
  for (const r of dueSubjects('user')) {
    // 还没有画像：只看记忆够不够多（不能把"没有画像"当成"很久没刷新"，否则 1 条记忆也会触发）
    if (r.generated_at === null) {
      if (r.total >= 3) push('user', r.subject_id);
      continue;
    }
    if (r.changed >= 5 || (r.changed >= 1 && now - r.generated_at > 7 * DAY)) push('user', r.subject_id);
  }
  for (const r of dueSubjects('guild')) {
    const age = r.generated_at ? now - r.generated_at : Infinity;
    if (r.changed >= 1 && age > DAY) push('guild', r.subject_id);
  }
  for (const r of dueSubjects('self')) {
    if ((r.generated_at === null && r.total >= 3) || r.changed >= 3) push('self', r.subject_id);
  }
  return queued;
}

/** 不需要 LLM 的统计刷新：最近 7 天出现过、统计超过 1 天没算的人（包括只发"哈哈"、攒不出记忆的人） */
export function refreshStaleStats(now: number = Date.now(), limit = 50): number {
  const rows = getDatabase()
    .query(
      `SELECT gm.guild_id, gm.user_id FROM guild_members gm
       JOIN users u ON u.user_id = gm.user_id AND u.is_self = 0 AND u.opted_out_at IS NULL
       LEFT JOIN user_stats s ON s.user_id = gm.user_id AND s.guild_id = gm.guild_id
       WHERE gm.last_seen_at >= ? AND gm.message_count > 0 AND (s.computed_at IS NULL OR s.computed_at < ?)
       ORDER BY gm.last_seen_at DESC LIMIT ?`
    )
    .all(now - 7 * DAY, now - DAY, limit) as Array<{ guild_id: string; user_id: string }>;
  for (const r of rows) saveUserStats(r.user_id, r.guild_id, computeUserStats(r.user_id, r.guild_id, now), now);
  return rows.length;
}

// ─── 提示词与输出 ──────────────────────────────────────────────────

export type ProfileResult = {
  summary: string;
  traits: Array<{ content: string; importance: number }>;
  pin: number[];
  unpin: number[];
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Math.trunc(Number(String(x).replace(/^#/, '')))).filter((x) => Number.isFinite(x) && x > 0) : [];

export function validateProfile(v: unknown): ProfileResult | null {
  if (!isObj(v) || typeof v.summary !== 'string' || !v.summary.trim()) return null;
  const traits = Array.isArray(v.traits)
    ? v.traits
        .filter(isObj)
        .map((t) => ({ content: typeof t.content === 'string' ? t.content.trim().slice(0, 200) : '', importance: Number(t.importance) || 6 }))
        .filter((t) => t.content)
        .slice(0, 3)
    : [];
  return { summary: v.summary.trim().slice(0, 900), traits, pin: ids(v.pin), unpin: ids(v.unpin) };
}

function memoryList(rows: MemoryRow[]): string {
  return rows
    .map((m) => {
      const label = m.slot ? `slot ${SLOT_LABEL[m.slot] ?? m.slot}` : KIND_LABEL[m.kind] ?? m.kind;
      const date = formatUtc8(m.event_at ?? m.updated_at).slice(0, 10);
      return `#${m.id}${m.pinned ? '（置顶）' : ''} [${label}] ${m.content}（${date}${m.confidence < 0.7 ? '，转述' : ''}）`;
    })
    .join('\n');
}

const PROFILE_RULES = [
  '只根据给出的资料写，不推测、不编造；资料互相矛盾时以较新的为准。',
  '标注"转述"的是别人说的，写进画像时要谨慎（可以写"据说…"）。',
  '只输出一个 JSON 对象，不要代码块、不要其它文字。',
].join('\n');

function userPrompt(userId: string, now: number): { system: string; user: string; watermark: number } {
  const db = getDatabase();
  // 画像会出现在别人的上下文里，所以只用非敏感记忆
  const rows = db
    .query(
      `SELECT * FROM memories WHERE scope = 'user' AND subject_id = ? AND status = 'active' AND sensitive = 0
       ORDER BY slot IS NOT NULL DESC, pinned DESC, importance DESC, updated_at DESC LIMIT 80`
    )
    .all(userId) as MemoryRow[];
  const relations = db
    .query(
      `SELECT * FROM memories WHERE scope = 'relation' AND status = 'active' AND sensitive = 0 AND (subject_id = ? OR object_id = ?)
       ORDER BY importance DESC, updated_at DESC LIMIT 15`
    )
    .all(userId, userId) as MemoryRow[];
  const guilds = (db.query('SELECT guild_id FROM guild_members WHERE user_id = ? ORDER BY message_count DESC').all(userId) as Array<{ guild_id: string }>).map(
    (r) => r.guild_id
  );
  const statsLines: string[] = [];
  for (const g of guilds.slice(0, 3)) {
    const st = computeUserStats(userId, g, now);
    saveUserStats(userId, g, st, now);
    const gname = (db.query('SELECT name FROM guilds WHERE guild_id = ?').get(g) as { name: string | null } | null)?.name ?? g;
    statsLines.push(`在「${gname}」：`, ...describeStats(st).map((l) => `- ${l}`));
  }
  const watermark = Math.max(0, ...rows.map((r) => r.updated_at), ...relations.map((r) => r.updated_at));
  const name = displayNameOf(userId, guilds[0] ?? null);
  const system = [
    `你在为一个 Discord 群聊角色整理对群友「${name}」的认识。`,
    '请输出：',
    '- summary：300–600 字的第三人称画像（这个人是谁、做什么、性格和说话风格、兴趣爱好、作息和活跃情况、最近的状况、和群里谁比较熟），写成连贯的一段话；',
    '- traits：最多 3 条更高层的归纳（"群里的技术担当，常帮人解决代码问题""夜猫子，凌晨最活跃"），每条带 importance（1–10）；没有把握就少写或不写；',
    '- pin：最值得每次聊天都想起的记忆 #id（最多 8 个，可以为空）；unpin：已经不重要、不该占核心位置的置顶记忆 #id。',
    PROFILE_RULES,
    '格式：{"summary":"…","traits":[{"content":"…","importance":7}],"pin":[12,15],"unpin":[3]}',
  ].join('\n');
  const user = [
    '## 身份',
    ...identityLines(userId, guilds[0] ?? null).map((l) => l.trim()),
    '',
    '## 活跃统计',
    ...(statsLines.length ? statsLines : ['（暂无）']),
    '',
    '## 记忆',
    rows.length ? memoryList(rows) : '（暂无）',
    ...(relations.length ? ['', '## 关系', memoryList(relations)] : []),
  ].join('\n');
  return { system, user, watermark };
}

function guildPrompt(guildId: string, now: number): { system: string; user: string; watermark: number } {
  const db = getDatabase();
  const rows = db
    .query(
      `SELECT * FROM memories WHERE scope = 'guild' AND subject_id = ? AND status = 'active' AND kind != 'episode'
       ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 60`
    )
    .all(guildId) as MemoryRow[];
  const episodes = db
    .query(
      `SELECT * FROM memories WHERE scope = 'guild' AND subject_id = ? AND status = 'active' AND kind = 'episode' AND created_at >= ?
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(guildId, now - 7 * DAY) as MemoryRow[];
  const name = (db.query('SELECT name FROM guilds WHERE guild_id = ?').get(guildId) as { name: string | null } | null)?.name ?? guildId;
  const system = [
    `你在为一个 Discord 群聊角色整理对服务器「${name}」的认识。`,
    '请输出 summary：200–500 字，说明这个群是做什么的、氛围如何、有哪些规矩和梗、最近在聊什么、群里的核心人物；',
    'pin：最值得每次都想起的服务器记忆 #id（最多 10 个）；unpin：不再重要的置顶 #id。traits 给空数组。',
    PROFILE_RULES,
    '格式：{"summary":"…","traits":[],"pin":[],"unpin":[]}',
  ].join('\n');
  const user = ['## 服务器记忆', rows.length ? memoryList(rows) : '（暂无）', '', '## 最近 7 天的聊天片段', episodes.length ? memoryList(episodes) : '（暂无）'].join('\n');
  return { system, user, watermark: Math.max(0, ...rows.map((r) => r.updated_at), ...episodes.map((r) => r.updated_at)) };
}

function selfPrompt(personaId: string): { system: string; user: string; watermark: number } {
  const rows = getDatabase()
    .query("SELECT * FROM memories WHERE scope = 'self' AND subject_id = ? AND status = 'active' ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 60")
    .all(personaId) as MemoryRow[];
  const persona = getPersona(personaId);
  const system = [
    `你是角色「${persona?.name ?? personaId}」。下面是你在群里说过的观点、偏好、经历和承诺。`,
    '请输出 summary：用第二人称"你"写 150–400 字，总结你对自己的了解（喜欢什么、讨厌什么、经历过什么、答应过谁什么），保证以后说话前后一致；',
    '与人设冲突的内容以人设为准，不要写进去。pin / unpin 同上（最多 8 个），traits 给空数组。',
    PROFILE_RULES,
    '格式：{"summary":"…","traits":[],"pin":[],"unpin":[]}',
  ].join('\n');
  const user = [persona ? `## 人设摘要\n${persona.summary}` : '', '## 你的自我记忆', rows.length ? memoryList(rows) : '（暂无）'].filter(Boolean).join('\n');
  return { system, user, watermark: Math.max(0, ...rows.map((r) => r.updated_at)) };
}

function applyPins(scope: ProfileScope, subjectId: string, result: ProfileResult, now: number): void {
  const owns = (id: number): MemoryRow | null => {
    const m = getMemory(id);
    return m && m.status === 'active' && m.scope === scope && m.subject_id === subjectId ? m : null;
  };
  for (const id of result.unpin) if (owns(id)?.pinned) updateMemory(id, { pinned: false }, now);
  for (const id of result.pin.slice(0, 10)) {
    const m = owns(id);
    if (m && !m.pinned && m.kind !== 'episode') updateMemory(id, { pinned: true }, now);
  }
}

/** 刷新一个主体的画像（含统计、反思与核心整理） */
export async function runRefreshProfile(scope: ProfileScope, subjectId: string, now: number = Date.now()): Promise<ProfileResult> {
  // 退出记录 / 已删除的人：一开始就放弃（不算统计、不调模型）
  if (scope === 'user' && (!userExists(subjectId) || isOptedOut(subjectId))) throw new PermanentJobError('用户已退出记录或已删除');
  const epoch = forgetEpoch();
  const p = scope === 'user' ? userPrompt(subjectId, now) : scope === 'guild' ? guildPrompt(subjectId, now) : selfPrompt(subjectId);
  const target = extractorTarget();
  const result = await jsonCompletion({
    target,
    purpose: 'profile',
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
    maxTokens: 1800,
    temperature: 0.3,
    timeoutMs: 120_000,
    validate: validateProfile,
  });
  // 等模型期间对方 /forget-me 或 /optout 了：不再写入
  if (scope === 'user' && (!userExists(subjectId) || isOptedOut(subjectId))) throw new PermanentJobError('用户数据已被删除');
  // 服务器 / 自我画像的输入里可能带着刚执行 /forget-me 的人：放弃这次结果，稍后用删除后的数据重做
  assertNoForgetSince(epoch);

  // 画像和反思特点会出现在别人能看到的档案里：去掉涉及敏感话题或禁止信息的句子 / 特点
  const summary = publicSentences(result.summary) || '（暂无可以公开的画像）';
  const traits = result.traits.filter((t) => isPublic(t.content));

  getDatabase().transaction(() => {
    saveProfile(scope, subjectId, summary, p.watermark, target.model, now);
    if (scope === 'user') {
      // 反思是整体重写的：去掉上一轮没被置顶的反思特点，再写入这一轮的
      getDatabase().run(
        "DELETE FROM memories WHERE scope = 'user' AND subject_id = ? AND origin = 'reflection' AND pinned = 0",
        [subjectId]
      );
      for (const t of traits) {
        addMemory(
          {
            scope: 'user',
            subjectId,
            kind: 'trait',
            content: t.content,
            importance: Math.max(1, Math.min(8, Math.round(t.importance))),
            confidence: 0.7,
            pinned: false,
            origin: 'reflection',
          },
          now
        );
      }
    }
    applyPins(scope, subjectId, result, now);
  })();
  // 写入反思 / 调整置顶用的时间戳是 now，会推高 updated_at：水位线推到 now，避免下一轮因为自己的写入又被判定为"有变化"。
  // 不能推到"当前最大的 updated_at"：生成期间别人写入的新记忆（时间晚于 now）模型没读过，要留给下一轮
  getDatabase().run('UPDATE profiles SET memory_watermark = ? WHERE scope = ? AND subject_id = ?', [Math.max(p.watermark, now), scope, subjectId]);
  logger.info('Memory', `已刷新${scope === 'user' ? `「${displayNameOf(subjectId, null)}」的` : scope === 'guild' ? '服务器' : '自我'}画像`);
  return result;
}

function isPublic(text: string): boolean {
  return !forbiddenReason(text) && !looksSensitive(text);
}

/** 只保留可以公开的句子 */
function publicSentences(text: string): string {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .filter((sentence) => isPublic(sentence))
    .join('')
    .trim();
}

export function registerProfiles(): void {
  registerJobHandler('refresh_profile', async (payload) => {
    const rec = isObj(payload) ? payload : {};
    const scope = rec.scope;
    const subjectId = typeof rec.subjectId === 'string' ? rec.subjectId : '';
    if ((scope !== 'user' && scope !== 'guild' && scope !== 'self') || !subjectId) throw new PermanentJobError('无效的画像任务');
    await runRefreshProfile(scope, subjectId);
  });
  // 运行中关掉记忆（WebUI）后不再投递 / 计算
  const memoryOn = (): boolean => getAiConfig().enabled && getAiConfig().memory.enabled;
  registerScheduler('profiles', 10 * 60_000, (now) => {
    if (memoryOn()) scheduleProfileRefresh(now);
  });
  registerScheduler('user-stats', 10 * 60_000, (now) => {
    if (memoryOn()) refreshStaleStats(now);
  });
}
