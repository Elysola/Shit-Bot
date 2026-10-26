import { ChannelType, type Channel, type Guild, type GuildMember, type Message, type PartialUser, type User } from 'discord.js';
import { getChannelName, type ChannelInfo } from './channels';
import { personFromDb, type DiscordUserInfo, type MemberInfo } from './identity';
import type { IngestAuthor, IngestMessage } from './ingest';
import { renderDiscordContent, type MentionResolver, type PersonRef, type RenderedContent } from './mentions';
import type { Attachment, MessageKind } from './messages';

export function userInfoFromDiscord(user: User | PartialUser): DiscordUserInfo {
  let avatarUrl: string | null = null;
  try {
    avatarUrl = user.displayAvatarURL({ size: 128 });
  } catch {
    avatarUrl = null;
  }
  return {
    id: user.id,
    username: user.username ?? user.id,
    globalName: user.globalName ?? null,
    avatarUrl,
    isBot: !!user.bot,
  };
}

export function memberInfoFromDiscord(member: GuildMember): MemberInfo {
  const roles = [...member.roles.cache.values()]
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
  return {
    guildId: member.guild.id,
    userId: member.id,
    nickname: member.nickname ?? null,
    roles,
    joinedAt: member.joinedTimestamp ?? null,
    premiumSince: member.premiumSinceTimestamp ?? null,
  };
}

export function personFromDiscord(user: User, member: GuildMember | null | undefined, selfId: string | null): PersonRef {
  const roles = member ? memberInfoFromDiscord(member).roles ?? [] : [];
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName ?? null,
    nickname: member?.nickname ?? null,
    displayName: member?.displayName || user.globalName || user.username,
    isBot: !!user.bot,
    isSelf: user.id === selfId,
    roles,
    joinedAt: member?.joinedTimestamp ?? null,
  };
}

export function channelTypeName(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText:
      return 'text';
    case ChannelType.GuildAnnouncement:
      return 'announcement';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return 'thread';
    case ChannelType.GuildForum:
      return 'forum';
    case ChannelType.GuildMedia:
      return 'media';
    case ChannelType.GuildVoice:
      return 'voice';
    case ChannelType.GuildStageVoice:
      return 'stage';
    default:
      return String(type);
  }
}

export function channelInfoFromDiscord(channel: Channel, guildId: string): ChannelInfo {
  const named = channel as Channel & { name?: string; parentId?: string | null; parent?: { parentId?: string | null } | null };
  return {
    channelId: channel.id,
    guildId,
    parentId: named.parentId ?? null,
    name: named.name ?? null,
    type: channelTypeName(channel.type),
    categoryId: named.parent?.parentId ?? null,
  };
}

/** bot 自己的托管角色（被 @ 这个角色视同 @bot） */
export function isSelfRole(guild: Guild | null, roleId: string, selfId: string | null): boolean {
  if (!guild || !selfId) return false;
  const role = guild.roles.cache.get(roleId);
  return !!role && role.tags?.botId === selfId;
}

/** 为某条消息构造提及解析器：消息自带的实时数据 → 缓存 → 库里的记录 */
export function resolverForMessage(message: Message, selfId: string | null): MentionResolver {
  const guild = message.guild;
  return {
    user: (id) => {
      const member = message.mentions.members?.get(id) ?? guild?.members.cache.get(id) ?? null;
      const user = message.mentions.users.get(id) ?? member?.user ?? message.client.users.cache.get(id) ?? null;
      if (user) return personFromDiscord(user, member, selfId);
      return personFromDb(id, guild?.id ?? null, selfId);
    },
    role: (id) => {
      const role = message.mentions.roles.get(id) ?? guild?.roles.cache.get(id);
      return role ? { id: role.id, name: role.name, isSelfRole: role.tags?.botId === selfId } : null;
    },
    channel: (id) => {
      const ch = message.client.channels.cache.get(id) as (Channel & { name?: string }) | undefined;
      const name = ch?.name ?? getChannelName(id);
      return name ? { id, name } : null;
    },
  };
}

export function renderMessage(message: Message, selfId: string | null, stripSelfMention = false): RenderedContent {
  return renderDiscordContent(message.content ?? '', resolverForMessage(message, selfId), { stripSelfMention });
}

export function attachmentsFromDiscord(message: Message): Attachment[] {
  return [...message.attachments.values()].slice(0, 10).map((a) => ({
    url: a.url,
    type: a.contentType?.toLowerCase() || (/\.(png|jpe?g|webp|gif)$/i.test(a.name || '') ? 'image' : 'file'),
    name: a.name || '',
  }));
}

/** 只有图片、且是模型能看的格式（png/jpeg/webp，≤10MB）才返回直链 */
export function imageUrlsFromDiscord(message: Message, max = 6): string[] {
  const urls: string[] = [];
  for (const att of message.attachments.values()) {
    const ct = att.contentType?.toLowerCase() || '';
    const supported = ct ? ct === 'image/png' || ct === 'image/jpeg' || ct === 'image/webp' : /\.(png|jpe?g|webp)$/i.test(att.name || '');
    if (supported && att.url && (att.size ?? 0) <= 10 * 1024 * 1024) urls.push(att.url);
    if (urls.length >= max) break;
  }
  return urls;
}

/** bot 转发推文等消息正文为空、内容在 embed 里：摘出可读文本 */
function embedsText(message: Message): string {
  return message.embeds
    .map((e) => [e.author?.name, e.title, e.description].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
    .slice(0, 600);
}

/** 入库时由发送方补充的信息：AI 回复记为 bot_ai；直接发到频道的插话记下它是冲哪条消息、哪个人说的（/forget-me 靠它删除） */
export type IngestOverrides = { kind?: MessageKind; proactive?: boolean; replyToId?: string; replyToAuthorId?: string; addressed?: boolean };

/**
 * discord.js Message → IngestMessage。
 * kind：bot 自己的消息默认记为 bot_other（转发推文、审批等），AI 回复由发送方以 bot_ai 显式记录。
 */
export function toIngestMessage(
  message: Message,
  selfId: string | null,
  source: 'live' | 'backfill',
  overrides: IngestOverrides = {}
): IngestMessage | null {
  if (!message.guild || !message.guildId) return null;
  const isSelf = message.author.id === selfId;
  const kind: MessageKind = overrides.kind ?? (isSelf ? 'bot_other' : 'user');
  const rendered = renderMessage(message, selfId);
  if (kind === 'bot_other' && !rendered.text.trim()) {
    const text = embedsText(message);
    if (text) rendered.text = `[转发/卡片] ${text}`;
  }
  const attachments = attachmentsFromDiscord(message);
  if (!rendered.text.trim() && attachments.length === 0 && message.stickers.size === 0) return null;
  if (!rendered.text.trim() && message.stickers.size > 0) {
    rendered.text = `[贴纸: ${[...message.stickers.values()].map((s) => s.name).join(', ')}]`;
  }

  const author: IngestAuthor = {
    user: userInfoFromDiscord(message.author),
    member: message.member ? memberInfoFromDiscord(message.member) : null,
  };
  const mentionedMembers: IngestAuthor[] = [];
  if (source === 'live') {
    for (const [id, user] of message.mentions.users) {
      const member = message.mentions.members?.get(id) ?? null;
      mentionedMembers.push({ user: userInfoFromDiscord(user), member: member ? memberInfoFromDiscord(member) : null });
    }
  }

  return {
    messageId: message.id,
    guildId: message.guildId,
    guildName: message.guild.name ?? null,
    channel: channelInfoFromDiscord(message.channel, message.guildId),
    author,
    kind,
    proactive: overrides.proactive,
    replyToId: overrides.replyToId ?? message.reference?.messageId ?? null,
    replyToAuthorId: overrides.replyToAuthorId ?? message.mentions.repliedUser?.id ?? null,
    contentRaw: message.content ?? '',
    rendered,
    mentionedMembers,
    attachments,
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp ?? null,
    source,
    addressed: overrides.addressed,
  };
}
