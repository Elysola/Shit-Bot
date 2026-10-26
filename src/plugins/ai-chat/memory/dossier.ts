import { getAiConfig } from '@/plugins/ai-chat/config';
import { getDatabase } from '@/storage';
import { getMeta } from '@/plugins/ai-chat/db/meta';
import { slotValueFromContent } from '@/plugins/ai-chat/db/schema';
import { getMember, getUser, parseRoles, personFromDb } from '@/plugins/ai-chat/identity';
import { describePresence } from '@/plugins/ai-chat/presence';
import { formatUtc8 } from '@/plugins/ai-chat/time';
import { getSavedUserStats } from './stats';
import { activeSlot, countByKind, KIND_LABEL, SLOT_LABEL, type MemoryRow, type MemoryScope } from './store';

const DAY = 86400000;

export function displayNameOf(userId: string, guildId: string | null): string {
  return personFromDb(userId, guildId, getMeta('bot.user_id'))?.displayName ?? `用户${userId.slice(-4)}`;
}

function ym(ms: number | null): string {
  return ms ? formatUtc8(ms).slice(0, 7) : '?';
}

function md(ms: number): string {
  return formatUtc8(ms).slice(5, 10);
}

export type AddressInfo = {
  /** 应该怎么称呼 TA */
  address: string;
  source: 'preferred' | 'nickname' | 'global' | 'username';
  /** 群里别人对 TA 的叫法（外号）以及是谁这么叫的 */
  aliases: Array<{ value: string; by: string | null }>;
};

const ADDRESS_SOURCE_LABEL: Record<AddressInfo['source'], string> = {
  preferred: '本人要求',
  nickname: '服务器昵称',
  global: '显示名',
  username: '用户名',
};

/**
 * 称呼优先级：本人要求 > 服务器昵称 > 全局显示名 > 用户名；外号单独列出（PLAN §3.3）。
 * 标为敏感的称呼 / 外号只给本人看（includeSensitive）；给别人看的档案、画像的输入都不带。
 */
export function addressOf(userId: string, guildId: string | null, opts: { includeSensitive?: boolean } = {}): AddressInfo {
  const u = getUser(userId);
  const m = guildId ? getMember(guildId, userId) : null;
  const slot = activeSlot('user', userId, 'preferred_name');
  const preferred = slot && (!slot.sensitive || opts.includeSensitive) ? slot : null;
  const aliasRows = getDatabase()
    .query(
      `SELECT value, content, source_user_id FROM memories
       WHERE scope = 'user' AND subject_id = ? AND kind = 'alias' AND status = 'active' AND (sensitive = 0 OR ?)
       ORDER BY importance DESC, updated_at DESC LIMIT 6`
    )
    .all(userId, opts.includeSensitive ? 1 : 0) as Array<{ value: string | null; content: string; source_user_id: string | null }>;
  const aliases = aliasRows
    .filter((a) => a.value)
    .map((a) => ({
      value: a.value as string,
      by: a.source_user_id && a.source_user_id !== userId ? displayNameOf(a.source_user_id, guildId) : null,
    }));

  const preferredValue = preferred ? preferred.value || slotValueFromContent(preferred.content) : null;
  if (preferredValue) return { address: preferredValue, source: 'preferred', aliases };
  if (m?.nickname) return { address: m.nickname, source: 'nickname', aliases };
  if (u?.global_name) return { address: u.global_name, source: 'global', aliases };
  return { address: u?.username ?? `用户${userId.slice(-4)}`, source: 'username', aliases };
}

/** 一条记忆的展示文本：内容 + 事件日期 + 转述来源（+ 可选的 #id 与类型） */
export function memoryLine(row: MemoryRow, guildId: string | null, opts: { withId?: boolean; withKind?: boolean } = {}): string {
  const tags: string[] = [];
  if (row.event_at) tags.push(formatUtc8(row.event_at).slice(0, 10));
  else tags.push(`记于 ${formatUtc8(row.updated_at).slice(0, 10)}`);
  if (row.kind === 'plan' && row.valid_until && row.valid_until < Date.now()) tags.push('已过期');
  if (row.source_user_id && row.source_user_id !== row.subject_id && row.scope !== 'self') {
    tags.push(`据 ${displayNameOf(row.source_user_id, guildId)} 说`);
  }
  if (row.status === 'superseded') tags.push('旧信息，已被更新');
  const prefix = `${opts.withId ? `#${row.id} ` : ''}${opts.withKind ? `[${KIND_LABEL[row.kind] ?? row.kind}] ` : ''}`;
  const slot = row.slot ? `${SLOT_LABEL[row.slot] ?? row.slot}：` : '';
  return `${prefix}${slot}${row.content}（${tags.join('；')}）`;
}

/** 身份行（PLAN §3.3 的渲染示例）；brief 时只给前两行 */
/** viewerIsSelf：看档案的就是本人（敏感的称呼 / 外号只给本人看） */
export function identityLines(userId: string, guildId: string | null, brief = false, viewerIsSelf = false): string[] {
  const u = getUser(userId);
  if (!u) return [`@未知用户（ID ${userId}）`];
  const m = guildId ? getMember(guildId, userId) : null;
  const display = m?.display_name ?? u.global_name ?? u.username;
  const addr = addressOf(userId, guildId, { includeSensitive: viewerIsSelf });

  let line1 = `@${display} ｜ 称呼：${addr.address}（${ADDRESS_SOURCE_LABEL[addr.source]}）`;
  const pronouns = activeSlot('user', userId, 'pronouns');
  if (pronouns && (!pronouns.sensitive || viewerIsSelf)) line1 += ` ｜ 代词：${pronouns.value ?? pronouns.content}`;
  if (addr.aliases.length) {
    line1 += ` ｜ 群里也叫：${addr.aliases.map((a) => (a.by ? `${a.value}(${a.by})` : a.value)).join('、')}`;
  }

  const former = (
    getDatabase()
      .query('SELECT DISTINCT value FROM name_history WHERE user_id = ? ORDER BY first_seen_at DESC LIMIT 8')
      .all(userId) as Array<{ value: string }>
  )
    .map((r) => r.value)
    .filter((v) => v !== u.username && v !== u.global_name && v !== m?.nickname)
    .slice(0, 4);
  const parts2 = [`ID ${userId}`, `用户名 ${u.username}`];
  if (u.global_name && u.global_name !== display) parts2.push(`显示名 ${u.global_name}`);
  if (m?.nickname && m.nickname !== display) parts2.push(`本服昵称 ${m.nickname}`);
  if (former.length) parts2.push(`曾用名 ${former.join('、')}`);
  if (u.is_bot) parts2.push('是 bot');
  const lines = [line1, `  ${parts2.join(' ｜ ')}`];
  if (brief) return lines;

  const parts3 = [`账号创建 ${ym(u.account_created_at)}`];
  if (m?.joined_at) parts3.push(`入群 ${ym(m.joined_at)}`);
  const roles = parseRoles(m?.roles ?? null);
  if (roles.length) parts3.push(`角色：${roles.slice(0, 6).map((r) => r.name).join('、')}`);
  const stats = guildId ? getSavedUserStats(userId, guildId) : null;
  if (stats?.peak) parts3.push(`常在 ${stats.peak} 活跃`);
  const presence = describePresence(userId);
  if (presence) parts3.push(`[${presence}]`);
  lines.push(`  ${parts3.join(' ｜ ')}`);
  return lines;
}

function profileSummary(scope: MemoryScope, subjectId: string): string | null {
  const row = getDatabase().query('SELECT summary FROM profiles WHERE scope = ? AND subject_id = ?').get(scope, subjectId) as
    | { summary: string }
    | null;
  return row?.summary?.trim() || null;
}

function firstSentence(s: string, max: number): string {
  const m = s.match(/^[^。！？!?\n]+[。！？!?]?/);
  return (m ? m[0] : s).slice(0, max);
}

/** "记忆目录"：告诉模型档案里还有多少、是哪些类型，提示它需要时自己去查 */
export function directoryLine(scope: MemoryScope, subjectId: string, includeSensitive: boolean, label: string, tool: string): string | null {
  const counts = countByKind(scope, subjectId, includeSensitive);
  const total = counts.reduce((a, c) => a + c.n, 0);
  if (total === 0) return `（档案里还没有关于${label}的其它记忆。）`;
  const recent = getDatabase()
    .query(
      `SELECT content, updated_at FROM memories WHERE scope = ? AND subject_id = ? AND status = 'active' ${includeSensitive ? '' : 'AND sensitive = 0'}
       ORDER BY updated_at DESC LIMIT 2`
    )
    .all(scope, subjectId) as Array<{ content: string; updated_at: number }>;
  const recentText = recent.length
    ? `；最近更新 ${md(recent[0].updated_at)}${recent.map((r) => `「${r.content.slice(0, 12)}${r.content.length > 12 ? '…' : ''}」`).join('')}`
    : '';
  const breakdown = counts
    .slice(0, 6)
    .map((c) => `${KIND_LABEL[c.kind] ?? c.kind} ${c.n}`)
    .join(' / ');
  return `（档案里关于${label}共有 ${total} 条记忆：${breakdown}${recentText}。上面只列了最重要的，需要细节时调用 ${tool}。）`;
}

/** 在预算内拼装段落：sections 按优先级排列，放不下的整行丢弃；tail（目录行）总是保留 */
export function fitToBudget(header: string, sections: string[][], tail: string | null, maxChars: number): string {
  const out: string[] = [header];
  let used = header.length + (tail ? tail.length + 1 : 0);
  for (const sec of sections) {
    for (const line of sec) {
      if (used + line.length + 1 > maxChars) continue;
      out.push(line);
      used += line.length + 1;
    }
  }
  if (tail) out.push(tail);
  return out.join('\n');
}

function activeRows(where: string, params: Array<string | number>, limit: number): MemoryRow[] {
  return getDatabase()
    .query(`SELECT * FROM memories WHERE status = 'active' AND ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
    .all(...params, limit) as MemoryRow[];
}

export type PersonCoreOptions = {
  guildId: string | null;
  /** 当前和 bot 说话的人：只有本人才看得到自己的敏感记忆 */
  viewerId: string | null;
  maxChars: number;
  detail: 'speaker' | 'mentioned';
  /** detail=mentioned 时：说话人，用来列出两人之间的关系 */
  speakerId?: string | null;
  /** 好感/关系的描述行（由好感模块提供） */
  relationshipLines?: string[];
  now?: number;
};

/** T1 核心档案：说话人 / 被提到的人 */
export function buildPersonCore(userId: string, o: PersonCoreOptions): string {
  const now = o.now ?? Date.now();
  const upcomingDays = getAiConfig().memory.core.upcomingDays;
  const sens = o.viewerId === userId ? '' : ' AND sensitive = 0';
  const isSpeaker = o.detail === 'speaker';
  const header = isSpeaker ? '[核心档案：正在和你说话的人]' : '[核心档案：本条消息提到的人]';
  const sections: string[][] = [];

  sections.push(identityLines(userId, o.guildId, !isSpeaker, o.viewerId === userId));
  if (o.relationshipLines?.length) sections.push(o.relationshipLines);

  const slots = activeRows(`scope = 'user' AND subject_id = ? AND slot IS NOT NULL AND slot NOT IN ('preferred_name', 'pronouns')${sens}`, [userId], 12);
  if (slots.length && isSpeaker) sections.push(slots.map((r) => `- ${SLOT_LABEL[r.slot!] ?? r.slot}：${r.value ?? r.content}`));

  const pinned = activeRows(`scope = 'user' AND subject_id = ? AND pinned = 1 AND slot IS NULL AND kind != 'alias'${sens}`, [userId], isSpeaker ? 12 : 3);
  if (pinned.length) sections.push(pinned.map((r) => `- ${memoryLine(r, o.guildId)}`));

  if (isSpeaker && upcomingDays > 0) {
    const shown = new Set(pinned.map((r) => r.id));
    const upcoming = (
      getDatabase()
        .query(
          `SELECT * FROM memories WHERE scope = 'user' AND subject_id = ? AND status = 'active'${sens}
           AND ((event_at BETWEEN ? AND ?) OR (kind = 'plan' AND valid_until >= ? AND created_at >= ?))
           ORDER BY COALESCE(event_at, valid_until) ASC LIMIT 8`
        )
        .all(userId, now - upcomingDays * DAY, now + upcomingDays * DAY, now, now - 60 * DAY) as MemoryRow[]
    ).filter((r) => !shown.has(r.id));
    if (upcoming.length) sections.push(['近期动态：', ...upcoming.slice(0, 5).map((r) => `- ${memoryLine(r, o.guildId)}`)]);
  }

  if (!isSpeaker && o.speakerId) {
    const rel = activeRows(
      `scope = 'relation' AND ((subject_id = ? AND object_id = ?) OR (subject_id = ? AND object_id = ?))${sens}`,
      [o.speakerId, userId, userId, o.speakerId],
      2
    );
    if (rel.length) sections.push(rel.map((r) => `- 和说话人的关系：${r.content}`));
  }

  const profile = profileSummary('user', userId);
  if (profile) sections.push([isSpeaker ? `画像：${profile}` : `画像：${firstSentence(profile, 80)}`]);

  const tail = directoryLine('user', userId, o.viewerId === userId, 'TA', 'search_memory 或 get_person');
  return fitToBudget(header, sections, tail, o.maxChars);
}

/** T1 核心档案：本服务器 */
export function buildGuildCore(guildId: string, maxChars: number, now: number = Date.now()): string | null {
  if (maxChars <= 0) return null;
  const guild = getDatabase().query('SELECT name FROM guilds WHERE guild_id = ?').get(guildId) as { name: string | null } | null;
  const header = `[核心档案：本服务器「${guild?.name ?? guildId}」]`;
  const sections: string[][] = [];
  const profile = profileSummary('guild', guildId);
  if (profile) sections.push([`概况：${profile}`]);
  const pinned = activeRows(`scope = 'guild' AND subject_id = ? AND pinned = 1 AND kind NOT IN ('episode','bot_alias')`, [guildId], 20);
  if (pinned.length) sections.push(pinned.map((r) => `- ${memoryLine(r, guildId, { withKind: true })}`));
  const episodes = getDatabase()
    .query(
      `SELECT * FROM memories WHERE scope = 'guild' AND subject_id = ? AND kind = 'episode' AND status = 'active' AND created_at >= ?
       ORDER BY created_at DESC LIMIT 3`
    )
    .all(guildId, now - 3 * DAY) as MemoryRow[];
  if (episodes.length) {
    sections.push(['最近群里聊过：', ...episodes.map((e) => `- ${md(e.event_at ?? e.created_at)} ${e.content.slice(0, 80)}`)]);
  }
  if (sections.length === 0 && countByKind('guild', guildId, false).length === 0) return null;
  const tail = directoryLine('guild', guildId, false, '本服务器', 'search_memory(about=guild)');
  return fitToBudget(header, sections, tail, maxChars);
}

export type SelfCoreInput = {
  personaId: string;
  personaName: string;
  guildId: string | null;
  maxChars: number;
  /** 当前心情的描述行（由情绪模块提供） */
  moodLines?: string[];
};

/** T1 核心档案：bot 自己（账号、群里对它的叫法、心情、自我记忆） */
export function buildSelfCore(i: SelfCoreInput): string | null {
  if (i.maxChars <= 0) return null;
  const selfId = getMeta('bot.user_id');
  const header = '[关于你自己]';
  const sections: string[][] = [];
  if (selfId) {
    const u = getUser(selfId);
    const m = i.guildId ? getMember(i.guildId, selfId) : null;
    const parts = [`你的 Discord 账号：${u?.username ?? i.personaName}（ID ${selfId}）`];
    if (m?.nickname) parts.push(`在本服务器的昵称：${m.nickname}`);
    sections.push([parts.join('；')]);
  }
  if (i.guildId) {
    const aliases = (
      getDatabase()
        .query(
          `SELECT DISTINCT value FROM memories WHERE scope = 'guild' AND subject_id = ? AND kind = 'bot_alias' AND status = 'active' AND value IS NOT NULL
           ORDER BY importance DESC LIMIT 6`
        )
        .all(i.guildId) as Array<{ value: string }>
    ).map((r) => r.value);
    if (aliases.length) sections.push([`群里的人这样叫你：${aliases.join('、')}`]);
  }
  if (i.moodLines?.length) sections.push(i.moodLines);
  const profile = profileSummary('self', i.personaId);
  if (profile) sections.push([`你对自己的了解：${profile}`]);
  const pinned = activeRows(`scope = 'self' AND subject_id = ? AND pinned = 1`, [i.personaId], 10);
  if (pinned.length) sections.push(['你说过、经历过的（保持前后一致）：', ...pinned.map((r) => `- ${memoryLine(r, i.guildId)}`)]);
  const tail = countByKind('self', i.personaId, true).length
    ? directoryLine('self', i.personaId, true, '你自己', 'search_memory(about=self)')
    : null;
  return fitToBudget(header, sections, tail, i.maxChars);
}
