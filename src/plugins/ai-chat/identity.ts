import { getDatabase, getDatabaseGeneration } from '@/storage';
import type { PersonRef } from './mentions';

export type DiscordUserInfo = {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
};

export type MemberRole = { id: string; name: string };

/** 成员资料。字段为 undefined 表示"这次没拿到"，不会覆盖库里已有的值（历史回望拉到的旧消息通常没有成员数据）。 */
export type MemberInfo = {
  guildId: string;
  userId: string;
  nickname?: string | null;
  roles?: MemberRole[];
  joinedAt?: number | null;
  premiumSince?: number | null;
};

export type UserRow = {
  user_id: string;
  username: string;
  global_name: string | null;
  avatar_url: string | null;
  is_bot: number;
  is_self: number;
  account_created_at: number;
  first_seen_at: number;
  last_seen_at: number;
  refreshed_at: number | null;
  opted_out_at: number | null;
};

export type MemberRow = {
  guild_id: string;
  user_id: string;
  nickname: string | null;
  display_name: string;
  roles: string | null;
  joined_at: number | null;
  premium_since: number | null;
  left_at: number | null;
  message_count: number;
  first_seen_at: number;
  last_seen_at: number;
  refreshed_at: number | null;
};

const DISCORD_EPOCH = 1420070400000n;
// 身份没变化时，最多每 5 分钟才写一次 last_seen_at，避免热路径上每条消息都写 users 表
const LAST_SEEN_WRITE_INTERVAL = 5 * 60 * 1000;

/** snowflake → 创建时间（epoch 毫秒）；非法 ID 返回 0 */
export function snowflakeTime(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

/** 比较两个 snowflake 的先后（字符串长度不同不能直接字典序比较） */
export function compareSnowflakes(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

/** 已写入库的身份签名，以及已写入的 first/last seen 区间 */
type CachedUser = { sig: string; minWritten: number; maxWritten: number };

let cacheGeneration = -1;
const userCache = new Map<string, CachedUser>();
const optOutCache = new Map<string, boolean>();
let legacyNames: Set<string> | null = null;

function ensureFreshCache(): void {
  const gen = getDatabaseGeneration();
  if (gen === cacheGeneration) return;
  userCache.clear();
  optOutCache.clear();
  legacyNames = null;
  cacheGeneration = gen;
}

function recordName(userId: string, guildId: string, kind: 'username' | 'global_name' | 'nick', value: string, at: number): void {
  if (!value) return;
  getDatabase().run(
    'INSERT OR IGNORE INTO name_history (user_id, guild_id, kind, value, first_seen_at) VALUES (?, ?, ?, ?, ?)',
    [userId, guildId, kind, value, at]
  );
}

/** 写入/刷新一个用户的资料；用户名或显示名变化时同时记入 name_history。 */
export function upsertUser(u: DiscordUserInfo, seenAt: number, opts: { isSelf?: boolean; refreshed?: boolean } = {}): void {
  ensureFreshCache();
  const sig = JSON.stringify([u.username, u.globalName, u.avatarUrl, u.isBot, !!opts.isSelf]);
  const cached = userCache.get(u.id);
  // 身份没变、时间落在已写入区间内（或只比上次写入晚一点点）时跳过写库
  if (
    cached &&
    cached.sig === sig &&
    !opts.refreshed &&
    seenAt >= cached.minWritten &&
    seenAt - cached.maxWritten < LAST_SEEN_WRITE_INTERVAL
  ) {
    return;
  }

  const db = getDatabase();
  const prev = db.query('SELECT username, global_name FROM users WHERE user_id = ?').get(u.id) as
    | { username: string; global_name: string | null }
    | null;

  db.run(
    `INSERT INTO users (user_id, username, global_name, avatar_url, is_bot, is_self, account_created_at,
                        first_seen_at, last_seen_at, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       global_name = excluded.global_name,
       avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
       is_bot = excluded.is_bot,
       is_self = MAX(users.is_self, excluded.is_self),
       first_seen_at = MIN(users.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(users.last_seen_at, excluded.last_seen_at),
       refreshed_at = COALESCE(excluded.refreshed_at, users.refreshed_at)`,
    [
      u.id,
      u.username,
      u.globalName,
      u.avatarUrl,
      u.isBot ? 1 : 0,
      opts.isSelf ? 1 : 0,
      snowflakeTime(u.id),
      seenAt,
      seenAt,
      opts.refreshed ? seenAt : null,
    ]
  );

  if (!prev || prev.username !== u.username) recordName(u.id, '', 'username', u.username, seenAt);
  if (u.globalName && (!prev || prev.global_name !== u.globalName)) recordName(u.id, '', 'global_name', u.globalName, seenAt);

  userCache.set(u.id, {
    sig,
    minWritten: Math.min(seenAt, cached?.minWritten ?? seenAt),
    maxWritten: Math.max(seenAt, cached?.maxWritten ?? seenAt),
  });
}

/** 服务器内显示名：昵称 > 全局显示名 > 用户名 */
export function computeDisplayName(nickname: string | null | undefined, user: Pick<DiscordUserInfo, 'globalName' | 'username'>): string {
  return nickname || user.globalName || user.username;
}

/**
 * 写入/刷新成员资料。countMessage=true 时发言数 +1（每条入库的用户消息调用一次）。
 * 昵称变化记入 name_history；未提供的字段保留库里的旧值。
 */
export function upsertMember(m: MemberInfo, user: DiscordUserInfo, seenAt: number, opts: { countMessage?: boolean; refreshed?: boolean } = {}): void {
  ensureFreshCache();
  const db = getDatabase();
  const prev = db.query('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(m.guildId, m.userId) as MemberRow | null;

  const nickname = m.nickname !== undefined ? m.nickname : prev?.nickname ?? null;
  const displayName = computeDisplayName(nickname, user);
  const roles = m.roles !== undefined ? JSON.stringify(m.roles) : prev?.roles ?? null;
  const joinedAt = m.joinedAt !== undefined ? m.joinedAt : prev?.joined_at ?? null;
  const premiumSince = m.premiumSince !== undefined ? m.premiumSince : prev?.premium_since ?? null;
  const inc = opts.countMessage ? 1 : 0;

  if (!prev) {
    db.run(
      `INSERT INTO guild_members (guild_id, user_id, nickname, display_name, roles, joined_at, premium_since,
                                  message_count, first_seen_at, last_seen_at, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.guildId, m.userId, nickname, displayName, roles, joinedAt, premiumSince, inc, seenAt, seenAt, opts.refreshed ? seenAt : null]
    );
  } else {
    db.run(
      `UPDATE guild_members SET nickname = ?, display_name = ?, roles = ?, joined_at = ?, premium_since = ?,
         left_at = CASE WHEN ? > COALESCE(left_at, 0) THEN NULL ELSE left_at END,
         message_count = message_count + ?,
         first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?),
         refreshed_at = COALESCE(?, refreshed_at)
       WHERE guild_id = ? AND user_id = ?`,
      [nickname, displayName, roles, joinedAt, premiumSince, seenAt, inc, seenAt, seenAt, opts.refreshed ? seenAt : null, m.guildId, m.userId]
    );
  }

  if (m.nickname && m.nickname !== prev?.nickname) recordName(m.userId, m.guildId, 'nick', m.nickname, seenAt);
}

/** 成员离开服务器（需要成员事件权限才收得到） */
export function markMemberLeft(guildId: string, userId: string, at: number): void {
  getDatabase().run('UPDATE guild_members SET left_at = ? WHERE guild_id = ? AND user_id = ?', [at, guildId, userId]);
}

export function upsertGuild(guildId: string, name: string | null, seenAt: number): void {
  getDatabase().run(
    `INSERT INTO guilds (guild_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET name = COALESCE(excluded.name, guilds.name), last_seen_at = MAX(guilds.last_seen_at, excluded.last_seen_at)`,
    [guildId, name, seenAt, seenAt]
  );
}

export function getUser(userId: string): UserRow | null {
  return getDatabase().query('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRow | null;
}

export function getMember(guildId: string, userId: string): MemberRow | null {
  return getDatabase().query('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as MemberRow | null;
}

export function parseRoles(raw: string | null): MemberRole[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((r): r is MemberRole => !!r && typeof r.id === 'string' && typeof r.name === 'string')
      : [];
  } catch {
    return [];
  }
}

/** 用库里的记录拼出一个 PersonRef（消息里拿不到实时数据时的兜底） */
export function personFromDb(userId: string, guildId: string | null, selfId: string | null): PersonRef | null {
  const u = getUser(userId);
  if (!u) return null;
  const m = guildId ? getMember(guildId, userId) : null;
  return {
    id: u.user_id,
    username: u.username,
    globalName: u.global_name,
    nickname: m?.nickname ?? null,
    displayName: m?.display_name ?? (u.global_name || u.username),
    isBot: !!u.is_bot,
    isSelf: !!u.is_self || u.user_id === selfId,
    roles: parseRoles(m?.roles ?? null),
    joinedAt: m?.joined_at ?? null,
  };
}

/** 用户是否已 /optout（结果按数据库代号缓存） */
export function isOptedOut(userId: string): boolean {
  ensureFreshCache();
  const cached = optOutCache.get(userId);
  if (cached !== undefined) return cached;
  const row = getDatabase().query('SELECT opted_out_at FROM users WHERE user_id = ?').get(userId) as { opted_out_at: number | null } | null;
  const out = !!row?.opted_out_at;
  optOutCache.set(userId, out);
  return out;
}

/** /optout 与 /optin。调用前应先 upsertUser 保证用户行存在。 */
export function setOptOut(userId: string, optedOut: boolean, at: number = Date.now()): void {
  ensureFreshCache();
  getDatabase().run('UPDATE users SET opted_out_at = ? WHERE user_id = ?', [optedOut ? at : null, userId]);
  optOutCache.set(userId, optedOut);
}

export function userExists(userId: string): boolean {
  return !!getDatabase().query('SELECT 1 FROM users WHERE user_id = ?').get(userId);
}

/** /forget-me 之后丢掉这个人的进程内缓存（否则 upsertUser 会以为资料已经写过） */
export function forgetIdentityCache(userId: string): void {
  userCache.delete(userId);
  optOutCache.delete(userId);
  legacyNames = null;
}

/** 所有已 optout 的用户 ID（给抽取器的排除名单） */
export function listOptedOutUserIds(): string[] {
  return (getDatabase().query('SELECT user_id FROM users WHERE opted_out_at IS NOT NULL').all() as Array<{ user_id: string }>).map(
    (r) => r.user_id
  );
}

// 旧数据里以 legacy:<username> 占位的列；表或列不存在时自动跳过（memories 表要到 Phase 3 的迁移才有）
const LEGACY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['messages', 'author_id'],
  ['memories', 'subject_id'],
  ['memories', 'source_user_id'],
];

function existingLegacyColumns(): Array<readonly [string, string]> {
  const db = getDatabase();
  return LEGACY_COLUMNS.filter(([table, col]) => {
    const cols = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === col);
  });
}

function loadLegacyNames(): Set<string> {
  const db = getDatabase();
  const names = new Set<string>();
  for (const [table, col] of existingLegacyColumns()) {
    const rows = db.query(`SELECT DISTINCT substr(${col}, 8) AS n FROM ${table} WHERE ${col} LIKE 'legacy:%'`).all() as Array<{ n: string }>;
    for (const r of rows) if (r.n) names.add(r.n);
  }
  return names;
}

/**
 * 旧数据只记了用户名。第一次见到用户名完全相同的用户时，把 legacy:<username> 占位改写成真实 user ID。
 * 只按完全相同的用户名绑定（Discord 新用户名全局唯一）；返回是否发生了绑定。
 */
export function bindLegacyIdentity(userId: string, username: string): boolean {
  ensureFreshCache();
  if (!legacyNames) legacyNames = loadLegacyNames();
  if (!legacyNames.has(username)) return false;
  const key = `legacy:${username}`;
  const db = getDatabase();
  let changed = 0;
  db.transaction(() => {
    const columns = existingLegacyColumns();
    if (columns.some(([table]) => table === 'memories')) {
      // 同一个 slot 真实 ID 下已经有新值（比如先用了 /callme）：旧值转为历史，避免违反"每个 slot 只有一条有效记忆"
      db.run(
        `UPDATE memories SET status = 'superseded', pinned = 0
         WHERE scope = 'user' AND subject_id = ? AND status = 'active' AND slot IS NOT NULL
           AND slot IN (SELECT slot FROM memories WHERE scope = 'user' AND subject_id = ? AND status = 'active' AND slot IS NOT NULL)`,
        [key, userId]
      );
    }
    for (const [table, col] of columns) {
      changed += db.run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [userId, key]).changes;
    }
  })();
  legacyNames.delete(username);
  if (changed > 0) console.log(`[Ingest] 旧数据身份绑定: ${username} → ${userId}（${changed} 行）`);
  return changed > 0;
}

export type UserRefContext = {
  guildId: string | null;
  speakerId: string | null;
  /** 本条消息涉及的人（按显示名精确匹配优先） */
  people: PersonRef[];
};

export type ResolveResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: Array<{ id: string; label: string }> };

const SELF_REFS = new Set(['me', 'speaker', 'self_user', '我', '自己', '说话人', '我自己']);

function labelFor(userId: string, guildId: string | null): string {
  const p = personFromDb(userId, guildId, null);
  return p ? `${p.displayName}（@${p.username}，ID ${userId}）` : `ID ${userId}`;
}

/**
 * 把模型写的用户引用解析成 user ID：ID / <@ID> / "我" → 本条消息涉及的人 → 本服昵称或显示名 → 用户名 / 全局名
 * → 外号 → 曾用名 → 模糊匹配。有歧义时返回候选列表让模型自己选。
 */
export function resolveUserRef(ref: string, ctx: UserRefContext): ResolveResult {
  const db = getDatabase();
  const raw = String(ref ?? '').trim();
  if (!raw) return { ok: false, reason: 'not_found', candidates: [] };
  if (SELF_REFS.has(raw.toLowerCase()) && ctx.speakerId) return { ok: true, userId: ctx.speakerId };

  const idMatch = raw.match(/^<@!?(\d{15,25})>$/) ?? raw.match(/^(\d{15,25})$/);
  if (idMatch) {
    return getUser(idMatch[1]) ? { ok: true, userId: idMatch[1] } : { ok: false, reason: 'not_found', candidates: [] };
  }

  const name = raw.replace(/^@/, '').trim();
  const lower = name.toLowerCase();
  const fromPeople = ctx.people.filter((p) => p.displayName.toLowerCase() === lower || p.username.toLowerCase() === lower);
  if (fromPeople.length === 1) return { ok: true, userId: fromPeople[0].id };

  const pick = (ids: string[]): ResolveResult | null => {
    const uniq = [...new Set(ids)];
    if (uniq.length === 1) return { ok: true, userId: uniq[0] };
    if (uniq.length > 1) {
      return { ok: false, reason: 'ambiguous', candidates: uniq.slice(0, 8).map((id) => ({ id, label: labelFor(id, ctx.guildId) })) };
    }
    return null;
  };
  const ids = (sql: string, ...params: Array<string | null>): string[] =>
    (db.query(sql).all(...params) as Array<{ id: string }>).map((r) => r.id);

  const exactSteps: Array<() => string[]> = [
    () =>
      ctx.guildId
        ? ids(
            'SELECT user_id AS id FROM guild_members WHERE guild_id = ? AND (lower(display_name) = ? OR lower(nickname) = ?)',
            ctx.guildId,
            lower,
            lower
          )
        : [],
    () => ids('SELECT user_id AS id FROM users WHERE lower(username) = ? OR lower(global_name) = ?', lower, lower),
    () => {
      const hasMemories = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
      // 敏感的外号（比如"糖友"）不能用来反查是谁：只有说话人自己的敏感外号可以
      return hasMemories
        ? ids(
            `SELECT DISTINCT subject_id AS id FROM memories WHERE scope = 'user' AND kind = 'alias' AND status = 'active' AND lower(value) = ?
             AND (sensitive = 0 OR subject_id = ?)`,
            lower,
            ctx.speakerId ?? ''
          ).filter((id) => /^\d+$/.test(id))
        : [];
    },
    () => ids('SELECT DISTINCT user_id AS id FROM name_history WHERE lower(value) = ?', lower),
  ];
  for (const step of exactSteps) {
    const r = pick(step());
    if (r) return r;
  }

  if ([...name].length < 2) return { ok: false, reason: 'not_found', candidates: [] };
  const like = `%${lower.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const fuzzy = [
    ...(ctx.guildId
      ? ids(
          "SELECT user_id AS id FROM guild_members WHERE guild_id = ? AND (lower(display_name) LIKE ? ESCAPE '\\' OR lower(nickname) LIKE ? ESCAPE '\\') LIMIT 8",
          ctx.guildId,
          like,
          like
        )
      : []),
    ...ids("SELECT user_id AS id FROM users WHERE lower(username) LIKE ? ESCAPE '\\' OR lower(global_name) LIKE ? ESCAPE '\\' LIMIT 8", like, like),
  ];
  return pick(fuzzy) ?? { ok: false, reason: 'not_found', candidates: [] };
}

/** 还没绑定到 user ID 的旧用户名（启动时用来做一次尽力而为的成员搜索） */
export function pendingLegacyUsernames(): string[] {
  ensureFreshCache();
  if (!legacyNames) legacyNames = loadLegacyNames();
  return [...legacyNames];
}
