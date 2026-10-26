import { getDatabase } from '@/storage';
import type { MentionRef } from './mentions';

export type MessageKind = 'user' | 'bot_ai' | 'bot_other';
export type MessageSource = 'live' | 'backfill' | 'legacy';
export type Attachment = { url: string; type: string; name: string };

export type NewMessage = {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorName: string;
  kind: MessageKind;
  proactive?: boolean;
  replyToId: string | null;
  /** 被回复消息的作者（只给 bot 的消息记，/forget-me 用） */
  replyToAuthorId?: string | null;
  contentRaw: string;
  contentText: string;
  mentions: MentionRef[];
  attachments: Attachment[];
  createdAt: number;
  editedAt?: number | null;
  source: Exclude<MessageSource, 'legacy'>;
};

export type StoredMessage = {
  id: number;
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string | null;
  author_name: string;
  msg_kind: MessageKind;
  proactive: number;
  reply_to_id: string | null;
  reply_to_author_id: string | null;
  content_raw: string;
  content_text: string;
  mentions: string | null;
  attachments: string | null;
  attachments_at: number | null;
  created_at: number;
  edited_at: number | null;
  extracted_at: number | null;
  source: MessageSource;
};

export type SaveResult = 'inserted' | 'updated' | 'unchanged';

const MAX_CONTENT = 4000;

/** 入库用的紧凑 mention 表示：只存 ID 和当时的名字，不存整份资料 */
export function serializeMentions(mentions: MentionRef[]): string | null {
  if (mentions.length === 0) return null;
  return JSON.stringify(
    mentions.map((m) => {
      switch (m.t) {
        case 'user':
          return { t: 'user', id: m.person.id, name: m.person.displayName };
        case 'unknown_user':
          return { t: 'user', id: m.id, name: null };
        case 'role':
          return { t: 'role', id: m.id, name: m.name };
        case 'channel':
          return { t: 'channel', id: m.id, name: m.name };
        default:
          return { t: m.t };
      }
    })
  );
}

export type StoredMention = { t: 'user' | 'role' | 'channel' | 'everyone' | 'here'; id?: string; name?: string | null };

export function parseStoredMentions(raw: string | null): StoredMention[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr.filter((x) => x && typeof x.t === 'string') as StoredMention[]) : [];
  } catch {
    return [];
  }
}

export function parseAttachments(raw: string | null): Attachment[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((a): a is Attachment => !!a && typeof a.url === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 保存一条消息（按 Discord message_id 去重）：
 * - 新消息：插入；
 * - 已存在的旧版迁移数据（source='legacy'，缺作者 ID/服务器）：用这次拿到的完整数据修复；
 * - forceKind：bot 自己的 AI 回复可能先被 messageCreate 当成普通发言入库，这里把类型纠正过来；
 * - 其余情况保持不变（不覆盖已有内容，编辑走 updateMessageContent）。
 */
export function saveMessage(m: NewMessage, opts: { forceKind?: boolean } = {}): SaveResult {
  const db = getDatabase();
  const contentRaw = m.contentRaw.slice(0, MAX_CONTENT);
  const contentText = m.contentText.slice(0, MAX_CONTENT);
  const mentions = serializeMentions(m.mentions);
  const attachments = m.attachments.length > 0 ? JSON.stringify(m.attachments.slice(0, 10)) : null;
  const attachmentsAt = m.attachments.length > 0 ? Date.now() : null;

  const ins = db.run(
    `INSERT OR IGNORE INTO messages
       (message_id, guild_id, channel_id, author_id, author_name, msg_kind, proactive, reply_to_id, reply_to_author_id,
        content_raw, content_text, mentions, attachments, attachments_at, created_at, edited_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.messageId,
      m.guildId,
      m.channelId,
      m.authorId,
      m.authorName,
      m.kind,
      m.proactive ? 1 : 0,
      m.replyToId,
      m.replyToAuthorId ?? null,
      contentRaw,
      contentText,
      mentions,
      attachments,
      attachmentsAt,
      m.createdAt,
      m.editedAt ?? null,
      m.source,
    ]
  );
  if (ins.changes > 0) return 'inserted';

  const prev = db.query('SELECT source, author_id, guild_id, msg_kind, proactive FROM messages WHERE message_id = ?').get(m.messageId) as
    | { source: MessageSource; author_id: string | null; guild_id: string; msg_kind: MessageKind; proactive: number }
    | null;
  if (!prev) return 'unchanged';

  if (prev.source === 'legacy') {
    db.run(
      `UPDATE messages SET guild_id = ?, author_id = COALESCE(?, author_id), author_name = ?, msg_kind = ?,
         reply_to_id = ?, reply_to_author_id = ?, content_raw = ?, content_text = ?, mentions = ?,
         attachments = COALESCE(?, attachments), attachments_at = COALESCE(?, attachments_at), source = ?
       WHERE message_id = ?`,
      [
        m.guildId,
        m.authorId,
        m.authorName,
        m.kind,
        m.replyToId,
        m.replyToAuthorId ?? null,
        contentRaw,
        contentText,
        mentions,
        attachments,
        attachmentsAt,
        m.source,
        m.messageId,
      ]
    );
    return 'updated';
  }

  const wantProactive = m.proactive ? 1 : 0;
  if (opts.forceKind && (prev.msg_kind !== m.kind || prev.proactive !== wantProactive)) {
    // Discord 回传的同一条消息可能先到并按"其它 bot 消息"入库了：升级类型，同时补上它是冲哪条消息说的
    db.run(
      'UPDATE messages SET msg_kind = ?, proactive = ?, reply_to_id = COALESCE(reply_to_id, ?), reply_to_author_id = COALESCE(reply_to_author_id, ?) WHERE message_id = ?',
      [m.kind, wantProactive, m.replyToId, m.replyToAuthorId ?? null, m.messageId]
    );
    return 'updated';
  }

  if (!prev.guild_id && m.guildId) {
    db.run('UPDATE messages SET guild_id = ? WHERE message_id = ?', [m.guildId, m.messageId]);
    return 'updated';
  }
  return 'unchanged';
}

/** 消息被编辑：只更新已入库的消息；返回是否更新了 */
export function updateMessageContent(
  messageId: string,
  contentRaw: string,
  contentText: string,
  mentions: MentionRef[],
  editedAt: number
): boolean {
  return (
    getDatabase().run(
      'UPDATE messages SET content_raw = ?, content_text = ?, mentions = ?, edited_at = ? WHERE message_id = ?',
      [contentRaw.slice(0, MAX_CONTENT), contentText.slice(0, MAX_CONTENT), serializeMentions(mentions), editedAt, messageId]
    ).changes > 0
  );
}

/** 消息被删除：物理删除（FTS 触发器同步删除索引）；返回是否删除了 */
export function deleteMessage(messageId: string): boolean {
  return getDatabase().run('DELETE FROM messages WHERE message_id = ?', [messageId]).changes > 0;
}

export function getStoredMessage(messageId: string): StoredMessage | null {
  return getDatabase().query('SELECT * FROM messages WHERE message_id = ?').get(messageId) as StoredMessage | null;
}

export function isMessageStored(messageId: string): boolean {
  return !!getDatabase().query('SELECT 1 FROM messages WHERE message_id = ?').get(messageId);
}

/** 某频道最近 count 条（时间从旧到新）；excludeMessageId 用于排除"当前这条"本身 */
export function recentChannelMessages(channelId: string, count: number, excludeMessageId?: string): StoredMessage[] {
  const db = getDatabase();
  const rows = (
    excludeMessageId
      ? db
          .query(
            `SELECT * FROM messages WHERE channel_id = ? AND message_id != ?
             ORDER BY created_at DESC, id DESC LIMIT ?`
          )
          .all(channelId, excludeMessageId, count)
      : db.query('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(channelId, count)
  ) as StoredMessage[];
  return rows.reverse();
}

export function countChannelMessages(channelId: string): number {
  return (getDatabase().query('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(channelId) as { c: number }).c;
}

/** 互动边：from 用户 @/回复/表情反应 了 to 用户 */
export function bumpInteraction(
  guildId: string,
  fromUserId: string,
  toUserId: string,
  kind: 'mentions' | 'replies' | 'reactions',
  at: number
): void {
  if (!guildId || fromUserId === toUserId) return;
  getDatabase().run(
    `INSERT INTO interaction_edges (guild_id, from_user_id, to_user_id, ${kind}, last_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(guild_id, from_user_id, to_user_id) DO UPDATE SET ${kind} = ${kind} + 1, last_at = MAX(last_at, excluded.last_at)`,
    [guildId, fromUserId, toUserId, at]
  );
}
