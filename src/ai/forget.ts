import { getDatabase } from '../storage';
import { bumpForgetEpoch, recordForgotten } from './forget-guard';
import { forgetIdentityCache } from './identity';
import { invalidateProfiles, parseParticipants } from './memory/store';
import { parseStoredMentions } from './messages';
import { forgetPresence } from './presence';
import { clearQueryCache } from './vector/service';
import { deleteVectorsOf } from './vector/store';

/**
 * /forget-me：删除一个人的全部数据（PLAN §13 / Phase 8）。规则：
 * 1. 删除：以 ta 为作者 / 主体 / 对象的所有行（消息、记忆、关系、好感与情绪记录、统计、画像、在线活动、互动关系、
 *    身份与曾用名、待执行的任务、旧版遗留数据），以及 bot 对 ta 那些消息的回复；
 * 2. 删除：提到 ta 名字的服务器记忆、bot 自我记忆，以及提到 ta 的服务器 / 自我画像（之后会自动重新生成）；
 * 3. 匿名化：别人消息里对 ta 的 @ 改成"@已删除的用户"；别人的数据里"信息来源是 ta"的标记清空；
 *    审计记录、印象、心情原因里出现的 ta 的名字改成"某人"。
 * 别人消息正文里不带 @ 地提到 ta 的名字属于别人的发言，不改动。
 */

const DELETED_MENTION = '@已删除的用户';
const SOMEONE = '某人';

export type ForgetReport = {
  messages: number;
  botReplies: number;
  scrubbedMessages: number;
  memories: number;
  vectors: number;
  rows: number;
};

function tableExists(name: string): boolean {
  return !!getDatabase().query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 别人（任何其他用户）是否也用过这个名字：身份名、曾用名、外号、指定的称呼都算 */
function nameUsedByOthers(userId: string, name: string): boolean {
  const n = name.toLowerCase();
  return !!getDatabase()
    .query(
      `SELECT 1 FROM users WHERE user_id != ?1 AND (lower(username) = ?2 OR lower(global_name) = ?2)
       UNION ALL SELECT 1 FROM guild_members WHERE user_id != ?1 AND (lower(nickname) = ?2 OR lower(display_name) = ?2)
       UNION ALL SELECT 1 FROM name_history WHERE user_id != ?1 AND lower(value) = ?2
       UNION ALL SELECT 1 FROM memories WHERE scope = 'user' AND subject_id != ?1 AND (kind = 'alias' OR slot = 'preferred_name') AND lower(value) = ?2
       LIMIT 1`
    )
    .get(userId, n);
}

/**
 * 这个人用过的名字（至少 2 个字，只保留别人没用过的——重名的、或者故意把称呼设成别人名字的，都不能拿来删别人的数据）：
 * - authorNames：身份名（用户名、显示名、服务器昵称、曾用名），用来认领升级前只记了显示名的旧消息；
 * - all：身份名 + 别人给 TA 起的外号 + bot 给 TA 起的称呼，用来找提到 TA 的共享记忆和需要匿名化的文字；
 *   TA 自己设的称呼（/callme、自称的外号）不算——否则把称呼设成"群规"再删除，就能把所有含"群规"的共享记忆抹掉；
 * - usernames：用户名，用来认领旧版按用户名记录的数据。
 */
export function namesOf(userId: string): { all: string[]; authorNames: string[]; usernames: string[] } {
  const db = getDatabase();
  const col = (sql: string, ...params: string[]): string[] =>
    (db.query(sql).all(...params) as Array<{ v: string | null }>).map((r) => r.v ?? '').filter(Boolean);
  const usernames = [
    ...col('SELECT username AS v FROM users WHERE user_id = ?', userId),
    ...col("SELECT value AS v FROM name_history WHERE user_id = ? AND kind = 'username'", userId),
  ];
  const identity = [
    ...usernames,
    ...col('SELECT global_name AS v FROM users WHERE user_id = ?', userId),
    ...col('SELECT nickname AS v FROM guild_members WHERE user_id = ?', userId),
    ...col('SELECT display_name AS v FROM guild_members WHERE user_id = ?', userId),
    ...col('SELECT value AS v FROM name_history WHERE user_id = ?', userId),
  ];
  const givenByOthers = [
    ...col(
      "SELECT value AS v FROM memories WHERE scope = 'user' AND subject_id = ? AND kind = 'alias' AND (source_user_id IS NULL OR source_user_id != ?)",
      userId,
      userId
    ),
    ...col('SELECT pet_name AS v FROM relationships WHERE user_id = ?', userId),
  ];
  const unique = (xs: string[]): string[] =>
    [...new Set(xs.map((x) => x.trim()).filter((x) => [...x].length >= 2))].filter((x) => !nameUsedByOthers(userId, x));
  // 长的先匹配，避免"阿伟"先把"阿伟伟"替换掉一半
  const byLength = (xs: string[]): string[] => xs.sort((a, b) => b.length - a.length);
  const authorNames = unique(identity);
  return {
    all: byLength([...new Set([...authorNames, ...unique(givenByOthers)])]),
    authorNames: byLength(authorNames),
    usernames: [...new Set(usernames)].filter((u) => !nameUsedByOthers(userId, u)),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 名字的匹配规则：纯 ASCII 的名字按单词边界、不区分大小写（避免 "bob" 命中 "bobby"），其它按子串 */
function nameRegex(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const parts = names.map((n) => (/^[\x20-\x7e]+$/.test(n) ? `(?<![A-Za-z0-9_])${escapeRe(n)}(?![A-Za-z0-9_])` : escapeRe(n)));
  return new RegExp(parts.join('|'), 'gi');
}

export function mentionsAny(text: string | null, re: RegExp | null): boolean {
  if (!text || !re) return false;
  re.lastIndex = 0;
  const hit = re.test(text);
  re.lastIndex = 0;
  return hit;
}

function scrub(text: string, re: RegExp | null): string {
  return re ? text.replace(re, SOMEONE) : text;
}

/** 别人消息里对这个人的 @：原文、渲染文本、提及列表都改掉 */
function scrubMentions(userId: string): number {
  const db = getDatabase();
  const rows = db
    .query(
      `SELECT id, content_raw, content_text, mentions FROM messages
       WHERE (author_id IS NULL OR author_id != ?) AND (mentions LIKE ? OR content_raw LIKE ?)`
    )
    .all(userId, `%"${userId}"%`, `%${userId}%`) as Array<{ id: number; content_raw: string; content_text: string; mentions: string | null }>;
  const idRe = new RegExp(`<@!?${userId}>`, 'g');
  let n = 0;
  for (const r of rows) {
    const mentions = parseStoredMentions(r.mentions);
    const labels: string[] = [];
    const kept = mentions.filter((m) => {
      if (m.t !== 'user' || m.id !== userId) return true;
      if (m.name) labels.push(m.name);
      return false;
    });
    let text = r.content_text;
    for (const label of labels) {
      text = text.replace(new RegExp(`@${escapeRe(label)}(?:\\(\\d+\\))?`, 'g'), DELETED_MENTION);
    }
    const raw = r.content_raw.replace(idRe, DELETED_MENTION);
    if (raw === r.content_raw && text === r.content_text && kept.length === mentions.length) continue;
    db.run('UPDATE messages SET content_raw = ?, content_text = ?, mentions = ? WHERE id = ?', [raw, text, kept.length ? JSON.stringify(kept) : null, r.id]);
    n++;
  }
  return n;
}

/** 删除一个人的全部数据。keepOptOut = 删除后继续保持"不记录"（只留下一个空的退出标记）。 */
export function forgetUser(userId: string, opts: { keepOptOut?: boolean; now?: number } = {}): ForgetReport {
  const db = getDatabase();
  const now = opts.now ?? Date.now();
  const { all: names, authorNames, usernames } = namesOf(userId);
  const nameRe = nameRegex(names);
  const legacyIds = usernames.map((u) => `legacy:${u}`);
  const subjects = [userId, ...legacyIds];
  const marks = (xs: unknown[]): string => xs.map(() => '?').join(',');
  const report: ForgetReport = { messages: 0, botReplies: 0, scrubbedMessages: 0, memories: 0, vectors: 0, rows: 0 };
  // 注意：bun:sqlite 的 changes 会把触发器（全文索引同步）的改动也算进去，messages / memories 的条数要先数再删
  const run = (sql: string, params: Array<string | number | null> = []): number => db.run(sql, params).changes;
  const count = (sql: string, params: Array<string | number> = []): number => (db.query(sql).get(...params) as { c: number }).c;

  // 被删除的内容同时从磁盘页里抹掉（只影响这一次操作）
  const prevSecure = (db.query('PRAGMA secure_delete').get() as { secure_delete: number } | null)?.secure_delete ?? 0;
  db.run('PRAGMA secure_delete = ON');
  let memoryIds: number[] = [];
  try {
    db.transaction(() => {
      // ── 消息 ────────────────────────────────────────────
      db.run('CREATE TEMP TABLE IF NOT EXISTS forget_msgs (message_id TEXT PRIMARY KEY)');
      db.run('DELETE FROM forget_msgs');
      db.run(`INSERT OR IGNORE INTO forget_msgs SELECT message_id FROM messages WHERE author_id IN (${marks(subjects)})`, subjects);
      if (usernames.length) {
        // 旧版一对一对话（每个用户一个虚拟频道），以及还没绑定到 ID 的旧频道消息
        db.run(`INSERT OR IGNORE INTO forget_msgs SELECT message_id FROM messages WHERE channel_id IN (${marks(usernames)})`, usernames.map((u) => `legacy-dm:${u}`));
      }
      if (authorNames.length) {
        // 升级前的旧频道消息只记了显示名：只认 TA 独有的身份名（自己设的称呼、和别人重名的名字都不算）
        db.run(
          `INSERT OR IGNORE INTO forget_msgs SELECT message_id FROM messages WHERE author_id IS NULL AND source = 'legacy' AND msg_kind = 'user' AND author_name IN (${marks(authorNames)})`,
          authorNames
        );
      }
      // bot 对 TA 说的话：回复的是 TA 的消息，或者记着回复对象是 TA（原消息已经被删掉 / 过了保留期也能找到）
      const botReplyIds = (
        db
          .query(
            `SELECT message_id FROM messages WHERE msg_kind != 'user'
               AND (reply_to_id IN (SELECT message_id FROM forget_msgs) OR reply_to_author_id IN (${marks(subjects)}))`
          )
          .all(...subjects) as Array<{ message_id: string }>
      ).map((r) => r.message_id);
      report.botReplies = botReplyIds.length;
      for (let i = 0; i < botReplyIds.length; i += 500) {
        const chunk = botReplyIds.slice(i, i + 500);
        // 消息墓碑：直接发到频道的插话在 Discord 上没有回复引用，回望再拉到时只能按消息 ID 认出来
        run(`INSERT OR IGNORE INTO forgotten_messages (message_id, forgotten_at) SELECT message_id, ? FROM messages WHERE message_id IN (${marks(chunk)})`, [now, ...chunk]);
        run(`DELETE FROM messages WHERE message_id IN (${marks(chunk)})`, chunk);
      }
      report.messages = count('SELECT COUNT(*) AS c FROM messages WHERE message_id IN (SELECT message_id FROM forget_msgs)');
      run('DELETE FROM messages WHERE message_id IN (SELECT message_id FROM forget_msgs)');
      // 连带删掉的 bot 回复也算"删掉的消息"：bot 的自我记忆以 bot 自己的消息为证据，下面按证据删除时要认得
      for (const id of botReplyIds) db.run('INSERT OR IGNORE INTO forget_msgs (message_id) VALUES (?)', [id]);
      report.scrubbedMessages = scrubMentions(userId);
      // 升级前的旧消息只存了 "@显示名" 的纯文本（没有提及列表）：按 TA 独有的身份名匿名化，旧消息表一并处理
      for (const n of authorNames) {
        const at = `@${n}`;
        const hit = "source = 'legacy' AND (instr(content_text, ?) > 0 OR instr(content_raw, ?) > 0)";
        report.scrubbedMessages += count(`SELECT COUNT(*) AS c FROM messages WHERE ${hit}`, [at, at]);
        run(`UPDATE messages SET content_text = replace(content_text, ?, ?), content_raw = replace(content_raw, ?, ?) WHERE ${hit}`, [
          at,
          DELETED_MENTION,
          at,
          DELETED_MENTION,
          at,
          at,
        ]);
        for (const t of ['channel_messages', '_legacy_channel_messages']) {
          if (tableExists(t)) report.rows += run(`UPDATE "${t}" SET content = replace(content, ?, ?) WHERE instr(content, ?) > 0`, [at, DELETED_MENTION, at]);
        }
      }

      // ── 记忆 ────────────────────────────────────────────
      const doomed = new Set<number>(
        (
          db
            .query(
              `SELECT id FROM memories WHERE (scope = 'user' AND subject_id IN (${marks(subjects)}))
               OR (scope = 'relation' AND (subject_id IN (${marks(subjects)}) OR object_id IN (${marks(subjects)})))`
            )
            .all(...subjects, ...subjects, ...subjects) as Array<{ id: number }>
        ).map((r) => r.id)
      );
      // 共享记忆（服务器、bot 自己）：信息来源是 TA、或证据是 TA 的消息（含 bot 对 TA 的回复）的整条删除——
      // 证据消息先被删掉 / 过了保留期也认得出来源；只是提到 TA 名字的，把名字换成"某人"，不整条删除
      // （名字匹配不可靠，删除只认结构化的关联）
      const deletedMsgIds = new Set((db.query('SELECT message_id FROM forget_msgs').all() as Array<{ message_id: string }>).map((r) => r.message_id));
      const shared = db
        .query("SELECT id, scope, subject_id, content, evidence, source_user_id, participants FROM memories WHERE scope IN ('guild', 'self')")
        .all() as Array<{
        id: number;
        scope: 'guild' | 'self';
        subject_id: string;
        content: string;
        evidence: string | null;
        source_user_id: string | null;
        participants: string | null;
      }>;
      // 被删除 / 匿名化的共享记忆所属的服务器、bot 自己：画像是从这些记忆写出来的，不管里面有没有写 TA 的名字都要失效
      const sharedTouched = { guild: new Set<string>(), self: new Set<string>() };
      for (const m of shared) {
        let ev: unknown = [];
        try {
          ev = m.evidence ? JSON.parse(m.evidence) : [];
        } catch {
          ev = [];
        }
        const fromThem =
          (m.source_user_id && subjects.includes(m.source_user_id)) ||
          parseParticipants(m.participants).some((p) => subjects.includes(p)) ||
          (Array.isArray(ev) && ev.some((x) => deletedMsgIds.has(String(x))));
        if (fromThem) {
          doomed.add(m.id);
          sharedTouched[m.scope].add(m.subject_id);
        }
        else if (mentionsAny(m.content, nameRe)) {
          report.rows += run('UPDATE memories SET content = ?, embed_model = NULL, updated_at = ? WHERE id = ?', [scrub(m.content, nameRe), now, m.id]);
          sharedTouched[m.scope].add(m.subject_id);
        }
      }
      memoryIds = [...doomed];
      // 关系的另一方：TA 的画像里多半汇总了和这个人的关系，删完要让它失效
      const counterparts = new Set<string>();
      for (const id of memoryIds) {
        const r = db.query("SELECT subject_id, object_id FROM memories WHERE id = ? AND scope = 'relation'").get(id) as { subject_id: string; object_id: string | null } | null;
        if (!r) continue;
        for (const x of [r.subject_id, r.object_id]) if (x && !subjects.includes(x)) counterparts.add(x);
      }
      for (const r of db.query('SELECT from_user_id AS a, to_user_id AS b FROM interaction_edges WHERE from_user_id = ? OR to_user_id = ?').all(userId, userId) as Array<{ a: string; b: string }>) {
        counterparts.add(r.a === userId ? r.b : r.a);
      }
      report.memories = memoryIds.length;
      for (let i = 0; i < memoryIds.length; i += 500) {
        const chunk = memoryIds.slice(i, i + 500);
        run(`UPDATE memories SET superseded_by = NULL WHERE superseded_by IN (${marks(chunk)})`, chunk);
        run(`DELETE FROM memories WHERE id IN (${marks(chunk)})`, chunk);
      }
      report.rows += run(`UPDATE memories SET source_user_id = NULL WHERE source_user_id IN (${marks(subjects)})`, subjects);
      // 证据里引用的、已经删掉的消息编号
      const deletedIds = new Set((db.query('SELECT message_id FROM forget_msgs').all() as Array<{ message_id: string }>).map((r) => r.message_id));
      if (deletedIds.size) {
        const withEvidence = db.query("SELECT id, evidence FROM memories WHERE evidence IS NOT NULL AND evidence != '[]'").all() as Array<{ id: number; evidence: string }>;
        for (const m of withEvidence) {
          let ev: unknown;
          try {
            ev = JSON.parse(m.evidence);
          } catch {
            continue;
          }
          if (!Array.isArray(ev)) continue;
          const kept = ev.filter((x) => !deletedIds.has(String(x)));
          if (kept.length !== ev.length) run('UPDATE memories SET evidence = ? WHERE id = ?', [JSON.stringify(kept), m.id]);
        }
      }

      // ── 画像 ────────────────────────────────────────────
      report.rows += run(`DELETE FROM profiles WHERE scope = 'user' AND subject_id IN (${marks(subjects)})`, subjects);
      // 和 TA 有关系、有互动的人的画像和反思特点（里面多半提到了 TA）：失效，之后按删除后的数据重新生成
      report.rows += invalidateProfiles('user', [...counterparts]);
      report.rows += invalidateProfiles('guild', [...sharedTouched.guild]);
      report.rows += invalidateProfiles('self', [...sharedTouched.self]);
      if (nameRe) {
        // 其余提到 TA 名字的画像（服务器、bot 自己、其他成员）和反思特点
        const shared = db.query('SELECT scope, subject_id, summary FROM profiles').all() as Array<{ scope: 'user' | 'guild' | 'self'; subject_id: string; summary: string }>;
        for (const p of shared) {
          if (mentionsAny(p.summary, nameRe)) report.rows += invalidateProfiles(p.scope, [p.subject_id]);
        }
        const traits = db.query("SELECT subject_id, content FROM memories WHERE scope = 'user' AND origin = 'reflection' AND pinned = 0").all() as Array<{
          subject_id: string;
          content: string;
        }>;
        const hit = new Set(traits.filter((t) => mentionsAny(t.content, nameRe)).map((t) => t.subject_id));
        report.rows += invalidateProfiles('user', [...hit]);
      }

      // ── 关系、好感、情绪 ─────────────────────────────────
      report.rows += run('DELETE FROM relationships WHERE user_id = ?', [userId]);
      report.rows += run('DELETE FROM affinity_events WHERE user_id = ?', [userId]);
      report.rows += run('DELETE FROM mood_events WHERE user_id = ?', [userId]);
      if (nameRe) {
        const texts: Array<[string, string, string]> = [
          ['relationships', 'user_id', 'impression'],
          ['affinity_events', 'id', 'reason'],
          ['mood_events', 'id', 'cause'],
          ['mood_state', 'soul_id', 'cause'],
        ];
        for (const [table, key, col] of texts) {
          const rows = db.query(`SELECT ${key} AS k, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all() as Array<{ k: string | number; v: string }>;
          for (const r of rows) {
            if (mentionsAny(r.v, nameRe)) report.rows += run(`UPDATE ${table} SET ${col} = ? WHERE ${key} = ?`, [scrub(r.v, nameRe), r.k]);
          }
        }
      }

      // ── 身份、统计、在线活动、互动关系 ───────────────────
      report.rows += run('DELETE FROM interaction_edges WHERE from_user_id = ? OR to_user_id = ?', [userId, userId]);
      report.rows += run('DELETE FROM activity_sessions WHERE user_id = ?', [userId]);
      report.rows += run('DELETE FROM user_stats WHERE user_id = ?', [userId]);
      // 别人的统计里（互动最多的人）也嵌着 TA 的 ID 和名字：删掉，下次按删除后的数据重算
      report.rows += run('DELETE FROM user_stats WHERE stats LIKE ?', [`%${userId}%`]);
      report.rows += run('DELETE FROM guild_members WHERE user_id = ?', [userId]);
      report.rows += run('DELETE FROM name_history WHERE user_id = ?', [userId]);
      // 任务载荷里带着 TA 的 ID：没在执行的直接删除；执行中的只清空载荷、保留这一行——
      // 删掉的话编号可能被新任务复用，旧任务结束时会按编号把新任务的状态改错。执行中的任务写入前会发现删除代次变了而放弃
      report.rows += run("DELETE FROM jobs WHERE status != 'running' AND payload LIKE ?", [`%${userId}%`]);
      report.rows += run("UPDATE jobs SET payload = '{}' WHERE status = 'running' AND payload LIKE ?", [`%${userId}%`]);
      if (opts.keepOptOut) {
        run(
          `INSERT INTO users (user_id, username, account_created_at, first_seen_at, last_seen_at, opted_out_at) VALUES (?, '', 0, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET username = '', global_name = NULL, avatar_url = NULL,
             first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, refreshed_at = NULL, opted_out_at = excluded.opted_out_at`,
          [userId, now, now, now]
        );
      } else {
        report.rows += run('DELETE FROM users WHERE user_id = ?', [userId]);
      }

      // ── 旧版遗留表（升级前的数据，只按用户名 / 显示名记录） ──
      for (const t of ['ai_conversations', '_legacy_ai_conversations', 'ai_memories', '_legacy_ai_memories']) {
        if (tableExists(t) && usernames.length) report.rows += run(`DELETE FROM "${t}" WHERE username IN (${marks(usernames)})`, usernames);
      }
      for (const t of ['channel_messages', '_legacy_channel_messages']) {
        if (tableExists(t) && authorNames.length) report.rows += run(`DELETE FROM "${t}" WHERE author IN (${marks(authorNames)})`, authorNames);
      }
      db.run('DELETE FROM forget_msgs');
      // 删除墓碑：之后历史回望再拉到 TA 删除前的消息也不会导回来（只存加盐哈希）
      recordForgotten(userId, now);
    })();
    // 让正在进行中的后台任务（提炼、画像、评估……）在写入前发现并放弃这次结果
    bumpForgetEpoch();
    // 向量在事务外删（sqlite 后端的二值索引是虚拟表）；记忆已经不在了，向量删不掉也不会再被检索到
    try {
      report.vectors = deleteVectorsOf('memory', memoryIds);
    } catch (e) {
      console.warn('[Forget] 删除向量失败（后台任务会再清理）:', (e as Error).message);
    }
    try {
      // 全文索引合并段，物理上去掉已删除消息的词条；WAL 里的旧页一并落盘截断
      db.run("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
      db.run("INSERT INTO memories_fts(memories_fts) VALUES('optimize')");
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 尽力而为
    }
  } finally {
    db.run(`PRAGMA secure_delete = ${prevSecure ? 'ON' : 'OFF'}`);
  }

  forgetIdentityCache(userId);
  forgetPresence(userId);
  clearQueryCache();
  console.log(
    `[Forget] 已删除用户 ${userId} 的数据：消息 ${report.messages}（bot 回复 ${report.botReplies}）、记忆 ${report.memories}、向量 ${report.vectors}、其它 ${report.rows} 行；匿名化 ${report.scrubbedMessages} 条别人的消息`
  );
  return report;
}
