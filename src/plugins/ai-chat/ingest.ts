import { getAiConfig } from './config';
import { getDatabase } from '@/storage';
import { isChannelDenylisted, upsertChannel, type ChannelInfo } from './channels';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import { forgottenBefore, isForgottenMessage } from './forget-guard';
import {
  bindLegacyIdentity,
  getMember,
  isOptedOut,
  snowflakeTime,
  upsertGuild,
  upsertMember,
  upsertUser,
  type DiscordUserInfo,
  type MemberInfo,
} from './identity';
import { mentionedPeople, type RenderedContent } from './mentions';
import { retentionCutoff } from './retention';
import {
  bumpInteraction,
  deleteMessage,
  getStoredMessage,
  saveMessage,
  updateMessageContent,
  type Attachment,
  type MessageKind,
  type SaveResult,
} from './messages';

export type IngestAuthor = { user: DiscordUserInfo; member: MemberInfo | null };

/** 一条消息的平台无关表示（由 discord-adapter 从 discord.js 的 Message 转换而来） */
export type IngestMessage = {
  messageId: string;
  guildId: string;
  guildName: string | null;
  channel: ChannelInfo;
  author: IngestAuthor;
  kind: MessageKind;
  proactive?: boolean;
  replyToId: string | null;
  replyToAuthorId: string | null;
  contentRaw: string;
  rendered: RenderedContent;
  /** 被 @ 的人的实时资料（只有实时消息才带成员数据），用于顺手刷新他们的身份 */
  mentionedMembers: IngestAuthor[];
  attachments: Attachment[];
  createdAt: number;
  editedAt: number | null;
  source: 'live' | 'backfill';
  /** 这条消息是在叫 bot（@ 它、回复它）：关掉被动观察时只记这类消息和 bot 的 AI 回复 */
  addressed?: boolean;
};

export type IngestResult = SaveResult | 'skipped';

/** 被动观察中：AI 已启用、AI 数据层可用、并且开启了被动观察或频道总结（编辑 / 表情 / 成员 / 在线状态 / 历史回望都看它） */
export function isIngestEnabled(): boolean {
  const ai = getAiConfig();
  return ai.enabled && isAiSchemaReady() && (ai.memory.observe.enabled || !!ai.summary?.enabled);
}

export function isGuildAllowed(guildId: string | null): boolean {
  const allowed = getAiConfig().allowedGuildIds;
  if (!allowed || allowed.length === 0) return !!guildId;
  return !!guildId && allowed.map(String).includes(guildId);
}

/** 这条消息该不该入库（不该入库时返回原因，便于测试和日志） */
export function skipReason(
  m: Pick<IngestMessage, 'guildId' | 'channel' | 'author' | 'kind'> &
    Partial<Pick<IngestMessage, 'messageId' | 'createdAt' | 'replyToId' | 'replyToAuthorId' | 'addressed'>>
): string | null {
  if (!getAiConfig().enabled || !isAiSchemaReady()) return 'disabled';
  // 关掉被动观察（也没开频道总结）时只记和 bot 的直接对话：叫到它的消息 + 它的 AI 回复
  if (!isIngestEnabled() && !(m.kind === 'user' ? m.addressed : m.kind === 'bot_ai')) return 'not-observed';
  if (!isGuildAllowed(m.guildId)) return 'guild-not-allowed';
  if (isChannelDenylisted(m.channel.channelId, m.channel.parentId, getAiConfig().memory.observe.channelDenylist, m.channel.categoryId)) return 'channel-denylisted';
  // 其他 bot 的消息不入库；bot 自己的发言以 bot_ai/bot_other 类型入库
  if (m.kind === 'user' && m.author.user.isBot) return 'other-bot';
  if (m.kind === 'user' && isOptedOut(m.author.user.id)) return 'opted-out';
  // TA /forget-me 之前的消息（历史回望又拉到了）不再导回来
  if (m.kind === 'user' && m.createdAt !== undefined && forgottenBefore(m.author.user.id, m.createdAt)) return 'forgotten';
  // /forget-me 时连带删掉的 bot 消息（比如直接发到频道的插话）：回望再拉到也不导回来
  if (m.kind !== 'user' && m.messageId && isForgottenMessage(m.messageId)) return 'forgotten';
  // bot 回复的是已退出记录的人、或 TA 删除之前的消息：回复里多半带着 TA 的信息，同样不入库
  if (m.kind !== 'user' && m.replyToAuthorId) {
    if (isOptedOut(m.replyToAuthorId)) return 'reply-to-opted-out';
    if (m.replyToId && forgottenBefore(m.replyToAuthorId, snowflakeTime(m.replyToId))) return 'reply-to-forgotten';
  }
  // 超过保留期的旧消息（历史回望拉到的）不入库，否则清理任务删完又被补回来
  const cutoff = retentionCutoff();
  if (cutoff !== null && m.createdAt !== undefined && m.createdAt < cutoff) return 'expired';
  return null;
}

/**
 * 记录一条消息及其附带的身份信息、互动关系。全部写入在一个事务里完成。
 * 热路径调用方必须自行 try/catch（这里出错会抛出，以便测试发现问题）。
 */
const DELETED_MENTION = '@已删除的用户';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 别人的旧消息里 @ 了之后执行过 /forget-me 的人（比如历史回望补拉到删除前没入库的消息）：
 * 和删除时对已入库消息做的一样，@ 改成"@已删除的用户"、从提及列表里去掉，也不再记互动关系。
 */
/** 正文和提及列表里去掉 createdAt 之后执行过 /forget-me 的人；gone 是被去掉的人 */
function scrubForgotten(contentRaw: string, rendered: RenderedContent, createdAt: number): { contentRaw: string; rendered: RenderedContent; gone: Set<string> } {
  const gone = new Set<string>();
  for (const ref of rendered.mentions) {
    const id = ref.t === 'user' ? ref.person.id : ref.t === 'unknown_user' ? ref.id : null;
    if (id && forgottenBefore(id, createdAt)) gone.add(id);
  }
  if (gone.size === 0) return { contentRaw, rendered, gone };
  let text = rendered.text;
  let raw = contentRaw;
  for (const ref of rendered.mentions) {
    if (ref.t === 'user' && gone.has(ref.person.id)) {
      text = text.replace(new RegExp(`@${escapeRe(ref.person.displayName || ref.person.username)}(?:\\(\\d+\\))?`, 'g'), DELETED_MENTION);
    }
  }
  for (const id of gone) raw = raw.replace(new RegExp(`<@!?${id}>`, 'g'), DELETED_MENTION);
  const mentions = rendered.mentions.filter((ref) => !((ref.t === 'user' && gone.has(ref.person.id)) || (ref.t === 'unknown_user' && gone.has(ref.id))));
  return { contentRaw: raw, rendered: { text, mentions }, gone };
}

/** 直接从 Discord 读到的旧消息（被引用的、插话的目标）交给模型前用：和入库一样，匿名化写这条消息之后执行过 /forget-me 的人 */
export function withoutForgottenRendered(rendered: RenderedContent, createdAt: number): RenderedContent {
  return scrubForgotten('', rendered, createdAt).rendered;
}

function withoutForgottenMentions(m: IngestMessage): IngestMessage {
  const scrubbed = scrubForgotten(m.contentRaw, m.rendered, m.createdAt);
  const replyGone = !!m.replyToAuthorId && forgottenBefore(m.replyToAuthorId, m.createdAt);
  if (scrubbed.gone.size === 0 && !replyGone) return m;
  return {
    ...m,
    contentRaw: scrubbed.contentRaw,
    rendered: scrubbed.rendered,
    mentionedMembers: m.mentionedMembers.filter((p) => !scrubbed.gone.has(p.user.id)),
    replyToAuthorId: replyGone ? null : m.replyToAuthorId,
  };
}

export function ingestMessage(input: IngestMessage, opts: { forceKind?: boolean } = {}): IngestResult {
  if (skipReason(input)) return 'skipped';
  const m = withoutForgottenMentions(input);
  const db = getDatabase();
  const at = m.createdAt;
  const authorId = m.author.user.id;
  const isSelf = m.kind !== 'user';

  let result: IngestResult = 'unchanged';
  db.transaction(() => {
    upsertGuild(m.guildId, m.guildName, at);
    upsertChannel(m.channel, Date.now());
    upsertUser(m.author.user, at, { isSelf });
    if (!isSelf) {
      // 旧数据身份绑定失败只告警，绝不能挡住这条消息入库
      try {
        bindLegacyIdentity(authorId, m.author.user.username);
      } catch (e) {
        console.warn(`[Ingest] 旧数据身份绑定失败(忽略): ${m.author.user.username}`, (e as Error).message);
      }
    }

    for (const p of m.mentionedMembers) {
      if (p.user.id === authorId || isOptedOut(p.user.id) || forgottenBefore(p.user.id, at)) continue;
      upsertUser(p.user, at);
      if (p.member) upsertMember(p.member, p.user, at);
    }

    // 历史回望拉到的旧消息通常不带成员数据：用库里已知的服务器昵称，而不是退回用户名
    const knownDisplay = m.author.member ? null : getMember(m.guildId, authorId)?.display_name;
    const authorName = m.author.member?.nickname || knownDisplay || m.author.user.globalName || m.author.user.username;
    result = saveMessage(
      {
        messageId: m.messageId,
        guildId: m.guildId,
        channelId: m.channel.channelId,
        authorId,
        authorName,
        kind: m.kind,
        proactive: m.proactive,
        replyToId: m.replyToId,
        // 只给 bot 的消息记（/forget-me 时找出 bot 对 TA 说过的话）；成员之间的回复已经记在互动关系里
        replyToAuthorId: isSelf ? m.replyToAuthorId : null,
        contentRaw: m.contentRaw,
        contentText: m.rendered.text,
        mentions: m.rendered.mentions,
        attachments: m.attachments,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        source: m.source,
      },
      opts
    );

    upsertMember(m.author.member ?? { guildId: m.guildId, userId: authorId }, m.author.user, at, {
      countMessage: result === 'inserted' && !isSelf,
    });

    if (result === 'inserted') {
      for (const p of mentionedPeople(m.rendered)) bumpInteraction(m.guildId, authorId, p.id, 'mentions', at);
      if (m.replyToAuthorId) bumpInteraction(m.guildId, authorId, m.replyToAuthorId, 'replies', at);
    }
  })();
  return result;
}

/** 消息被编辑：只更新已入库的消息 */
export function ingestEdit(messageId: string, contentRaw: string, rendered: RenderedContent, editedAt: number): boolean {
  // 只更新已经入库的消息：关掉被动观察时入库的直接对话被编辑了也要同步（比如删掉了里面的私人信息）
  if (!getAiConfig().enabled || !isAiSchemaReady()) return false;
  // 编辑后 Discord 给的是完整的新正文：删除时匿名化过的 @ 不能借编辑写回来
  const stored = getStoredMessage(messageId);
  const clean = stored ? scrubForgotten(contentRaw, rendered, stored.created_at) : { contentRaw, rendered };
  return updateMessageContent(messageId, clean.contentRaw, clean.rendered.text, clean.rendered.mentions, editedAt);
}

/** 消息被删除：同步物理删除 */
export function ingestDelete(messageId: string): boolean {
  if (!isAiSchemaReady()) return false;
  return deleteMessage(messageId);
}

export type ReactedMessage = { authorId: string | null; kind: MessageKind; proactive: boolean; channelId: string };

/**
 * 有人给某条已入库的消息贴了表情：记为一次互动（反应者 → 消息作者）。
 * 返回被反应消息的作者信息（主动插话的反馈统计要用），消息不在库里时返回 null。
 */
export function recordReaction(guildId: string, messageId: string, reactor: DiscordUserInfo, at: number): ReactedMessage | null {
  if (!isIngestEnabled() || !isGuildAllowed(guildId)) return null;
  const msg = getStoredMessage(messageId);
  if (!msg) return null;
  const reacted: ReactedMessage = {
    authorId: msg.author_id,
    kind: msg.msg_kind,
    proactive: !!msg.proactive,
    channelId: msg.channel_id,
  };
  if (reactor.isBot || isOptedOut(reactor.id)) return reacted;
  upsertUser(reactor, at);
  if (msg.author_id && msg.author_id !== reactor.id) bumpInteraction(guildId, reactor.id, msg.author_id, 'reactions', at);
  return reacted;
}
