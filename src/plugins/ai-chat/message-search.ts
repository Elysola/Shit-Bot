import { getDatabase } from '@/storage';
import { getChannelName } from './channels';
import { escapeLike, ftsMatchExpr, queryTerms } from '@/plugins/ai-chat/memory/scoring';
import type { StoredMessage } from './messages';
import { formatUtc8 } from './time';

export type MessageQuery = {
  /** null = 不限服务器（跨服务器读取原话时） */
  guildId: string | null;
  authorId?: string;
  channelId?: string;
  /** 只在这些频道里找（读原话的权限过滤；空数组 = 一条都不给） */
  channelIds?: readonly string[];
  query?: string;
  since?: number;
  until?: number;
  /** 无关键词时的分页游标（encodeCursor 生成） */
  cursor?: string | null;
  /** 有关键词时的分页偏移 */
  offset?: number;
  limit: number;
};

export type MessagePage = { rows: StoredMessage[]; nextCursor: string | null; nextOffset: number | null; total: number | null };

export function encodeCursor(createdAt: number, id: number): string {
  return Buffer.from(`${createdAt}:${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: number; id: number } | null {
  if (!cursor) return null;
  try {
    const [a, b] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const createdAt = Number(a);
    const id = Number(b);
    return Number.isFinite(createdAt) && Number.isFinite(id) ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

function baseFilter(q: MessageQuery): { sql: string; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.guildId !== null) {
    where.push('m.guild_id = ?');
    params.push(q.guildId);
  }
  if (q.authorId) {
    where.push('m.author_id = ?');
    params.push(q.authorId);
  }
  if (q.channelId) {
    where.push('m.channel_id = ?');
    params.push(q.channelId);
  }
  if (q.channelIds) {
    if (q.channelIds.length === 0) where.push('0');
    else {
      where.push(`m.channel_id IN (${q.channelIds.map(() => '?').join(',')})`);
      params.push(...q.channelIds);
    }
  }
  if (q.since !== undefined) {
    where.push('m.created_at >= ?');
    params.push(q.since);
  }
  if (q.until !== undefined) {
    where.push('m.created_at <= ?');
    params.push(q.until);
  }
  return { sql: where.length ? where.join(' AND ') : '1', params };
}

/**
 * 查原始消息：没有关键词时按时间倒序翻页（游标）；有关键词时 FTS（trigram）+ LIKE（短词）并集，
 * 按命中程度排序、同分按时间倒序（偏移分页）。
 */
export function searchMessages(q: MessageQuery): MessagePage {
  const db = getDatabase();
  const f = baseFilter(q);
  const limit = Math.max(1, Math.min(q.limit, 200));

  if (!q.query?.trim()) {
    const cur = decodeCursor(q.cursor);
    const curSql = cur ? ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))' : '';
    const curParams = cur ? [cur.createdAt, cur.createdAt, cur.id] : [];
    const rows = db
      .query(`SELECT m.* FROM messages m WHERE ${f.sql}${curSql} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
      .all(...f.params, ...curParams, limit + 1) as StoredMessage[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page, nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null, nextOffset: null, total: null };
  }

  const terms = queryTerms(q.query);
  const scores = new Map<number, number>();
  if (terms.fts.length) {
    try {
      const ftsRows = db
        .query(
          `SELECT m.id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
           WHERE messages_fts MATCH ? AND ${f.sql} ORDER BY bm25(messages_fts) LIMIT 500`
        )
        .all(ftsMatchExpr(terms.fts), ...f.params) as Array<{ id: number }>;
      ftsRows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 2 - i / 500));
    } catch (e) {
      console.warn('[Memory] 消息全文检索失败(改用 LIKE):', (e as Error).message);
    }
  }
  if (terms.like.length) {
    const ors = terms.like.map(() => "m.content_text LIKE ? ESCAPE '\\'").join(' OR ');
    const likeRows = db
      .query(`SELECT m.id, m.content_text FROM messages m WHERE ${f.sql} AND (${ors}) ORDER BY m.created_at DESC LIMIT 500`)
      .all(...f.params, ...terms.like.map(escapeLike)) as Array<{ id: number; content_text: string }>;
    for (const r of likeRows) {
      const text = r.content_text.toLowerCase();
      const hits = terms.like.filter((t) => text.includes(t.toLowerCase())).length;
      scores.set(r.id, (scores.get(r.id) ?? 0) + hits / terms.like.length);
    }
  }
  if (scores.size === 0) return { rows: [], nextCursor: null, nextOffset: null, total: 0 };

  const ids = [...scores.keys()];
  const rows = db.query(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as StoredMessage[];
  rows.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || b.created_at - a.created_at);
  const offset = q.offset ?? 0;
  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + limit < rows.length ? offset + limit : null;
  return { rows: page, nextCursor: null, nextOffset, total: rows.length };
}

/** 某条消息前后各 n 条（同频道，时间从旧到新） */
export function messagesAround(messageId: string, n: number): StoredMessage[] {
  const db = getDatabase();
  const pivot = db.query('SELECT * FROM messages WHERE message_id = ?').get(messageId) as StoredMessage | null;
  if (!pivot) return [];
  const before = db
    .query(
      `SELECT * FROM messages WHERE channel_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(pivot.channel_id, pivot.created_at, pivot.created_at, pivot.id, n) as StoredMessage[];
  const after = db
    .query(
      `SELECT * FROM messages WHERE channel_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .all(pivot.channel_id, pivot.created_at, pivot.created_at, pivot.id, n) as StoredMessage[];
  return [...before.reverse(), pivot, ...after];
}

/** 一行原始消息：[时间] #频道 作者: 内容（bot 自己的发言标为"你"） */
export function formatMessageLine(m: StoredMessage, opts: { withChannel?: boolean; withId?: boolean; maxLen?: number } = {}): string {
  const author = m.msg_kind === 'user' ? m.author_name : `你(${m.author_name})`;
  const channel = opts.withChannel ? ` #${getChannelName(m.channel_id) ?? m.channel_id}` : '';
  const id = opts.withId ? ` ⟨${m.message_id}⟩` : '';
  const text = m.content_text.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, opts.maxLen ?? 400);
  return `[${formatUtc8(m.created_at).slice(0, 16)}]${channel} ${author}: ${text}${id}`;
}
