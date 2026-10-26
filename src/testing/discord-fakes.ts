import { EventEmitter } from 'events';
import { ChannelType, Collection, type ChatInputCommandInteraction, type Client, type Message } from 'discord.js';
import { CHANNEL_ID, GUILD_ID, snowflakeAt } from './fixtures';

/**
 * 只实现 bot 代码实际用到的那部分 discord.js 接口的假客户端 / 频道 / 消息 / 斜杠命令交互，用于不连 Discord 的集成测试。
 * 发出的消息记在 channel.sent，贴的表情记在 message.reactedWith，命令的回复记在 interaction.replies。
 */

export type SendOptions = { content: string; allowedMentions?: unknown };

export type FakeAuthor = { id: string; username: string; globalName?: string | null; bot?: boolean; nickname?: string | null };

export type FakeMessage = Message & { reactedWith: string[] };

export type FakeChannel = {
  id: string;
  type: ChannelType;
  name: string;
  parentId: string | null;
  /** bot 自己 */
  self: FakeAuthor;
  sent: Array<{ message: FakeMessage; options: SendOptions; replyTo: string | null }>;
  typing: number;
  store: Map<string, FakeMessage>;
  /** 发消息的回调（假客户端用它把 bot 发出的消息也当作 messageCreate 事件广播出去） */
  onSent: ((m: FakeMessage) => void) | null;
  isTextBased: () => true;
  sendTyping: () => Promise<void>;
  send: (options: SendOptions) => Promise<FakeMessage>;
  messages: { fetch: (id: string) => Promise<FakeMessage> };
};

const guild = {
  id: GUILD_ID,
  name: '测试服',
  members: { cache: new Collection<string, unknown>() },
  roles: { cache: new Collection<string, unknown>() },
};
const sharedClient = { users: { cache: new Collection<string, unknown>() }, channels: { cache: new Collection<string, unknown>() } };

export function fakeChannel(selfAuthor: FakeAuthor, id: string = CHANNEL_ID, name = '闲聊'): FakeChannel {
  const ch: FakeChannel = {
    id,
    type: ChannelType.GuildText,
    name,
    parentId: null,
    self: selfAuthor,
    sent: [],
    typing: 0,
    store: new Map(),
    onSent: null,
    isTextBased: () => true,
    sendTyping: async () => {
      ch.typing++;
    },
    send: async (options) => sendAs(ch, options, null),
    messages: {
      fetch: async (mid) => {
        const m = ch.store.get(mid);
        if (!m) throw new Error('Unknown Message');
        return m;
      },
    },
  };
  return ch;
}

async function sendAs(ch: FakeChannel, options: SendOptions, replyTo: FakeMessage | null): Promise<FakeMessage> {
  const m = fakeMessage(ch, ch.self, options.content, { replyTo });
  ch.sent.push({ message: m, options, replyTo: replyTo?.id ?? null });
  ch.onSent?.(m);
  return m;
}

function fakeUser(a: FakeAuthor): Record<string, unknown> {
  return {
    id: a.id,
    username: a.username,
    globalName: a.globalName ?? null,
    bot: !!a.bot,
    partial: false,
    displayAvatarURL: () => `https://cdn.test/${a.id}.png`,
  };
}

function fakeMember(a: FakeAuthor): Record<string, unknown> | null {
  if (a.nickname === undefined) return null;
  return {
    id: a.id,
    user: fakeUser(a),
    nickname: a.nickname,
    displayName: a.nickname || a.globalName || a.username,
    roles: { cache: new Collection() },
    guild: { id: GUILD_ID },
    joinedTimestamp: null,
    premiumSinceTimestamp: null,
  };
}

export function fakeMessage(
  ch: FakeChannel,
  author: FakeAuthor,
  content: string,
  opts: { createdAt?: number; replyTo?: FakeMessage | null; mentions?: FakeAuthor[] } = {}
): FakeMessage {
  const createdAt = opts.createdAt ?? Date.now();
  const users = new Collection<string, unknown>();
  const members = new Collection<string, unknown>();
  for (const p of opts.mentions ?? []) {
    users.set(p.id, fakeUser(p));
    const mem = fakeMember(p);
    if (mem) members.set(p.id, mem);
  }
  const everyone = /@(everyone|here)\b/.test(content);
  const repliedUser = opts.replyTo ? opts.replyTo.author : null;
  const reactedWith: string[] = [];
  const m = {
    id: snowflakeAt(createdAt),
    content,
    guild,
    guildId: GUILD_ID,
    channel: ch,
    channelId: ch.id,
    client: sharedClient,
    author: fakeUser(author),
    member: fakeMember(author),
    mentions: {
      users,
      members,
      roles: new Collection<string, unknown>(),
      repliedUser,
      everyone,
      has: (id: string, o: { ignoreEveryone?: boolean; ignoreRepliedUser?: boolean } = {}): boolean =>
        users.has(id) || (!o.ignoreRepliedUser && repliedUser?.id === id) || (!o.ignoreEveryone && everyone),
    },
    attachments: new Collection(),
    embeds: [],
    stickers: new Collection(),
    reference: opts.replyTo ? { messageId: opts.replyTo.id } : null,
    createdTimestamp: createdAt,
    editedTimestamp: null,
    reactedWith,
    react: async (emoji: string) => {
      reactedWith.push(emoji);
    },
    reply: async (options: SendOptions) => sendAs(ch, options, m as unknown as FakeMessage),
  };
  const fm = m as unknown as FakeMessage;
  ch.store.set(fm.id, fm);
  return fm;
}

export type FakeClient = Client & { emitMessage: (m: FakeMessage) => void };

/** 假的 discord.js 客户端：只有事件分发和 bot 自己的身份；isReady() 为 false，不触发启动时的历史同步 */
export function fakeClient(self: FakeAuthor): FakeClient {
  const em = new EventEmitter();
  const c = Object.assign(em, {
    user: fakeUser(self),
    users: sharedClient.users,
    channels: sharedClient.channels,
    guilds: { cache: new Collection() },
    isReady: () => false,
    emitMessage: (m: FakeMessage) => {
      em.emit('messageCreate', m);
    },
  });
  return c as unknown as FakeClient;
}

export type FakeInteraction = ChatInputCommandInteraction & {
  replies: string[];
  /** 下一次 awaitMessageComponent 返回的按钮（null = 超时） */
  click: string | null;
};

/** 假的斜杠命令交互；回复内容（含 editReply / 按钮 update）按顺序记在 replies */
export function fakeInteraction(
  commandName: string,
  user: FakeAuthor,
  ch: FakeChannel,
  options: Record<string, string | number | undefined> = {},
  opts: { click?: string | null; guildId?: string | null } = {}
): FakeInteraction {
  const replies: string[] = [];
  const it = {
    commandName,
    user: fakeUser(user),
    guildId: opts.guildId === undefined ? GUILD_ID : opts.guildId,
    channelId: ch.id,
    channel: ch,
    deferred: false,
    replied: false,
    replies,
    click: opts.click ?? null,
    isChatInputCommand: () => true,
    options: {
      getInteger: (name: string) => (typeof options[name] === 'number' ? (options[name] as number) : null),
      getString: (name: string) => (typeof options[name] === 'string' ? (options[name] as string) : null),
    },
    reply: async (body: { content?: string; files?: unknown[] }) => {
      it.replied = true;
      replies.push(body.content ?? '');
      const button = {
        customId: '',
        update: async (b: { content?: string }) => {
          replies.push(b.content ?? '');
        },
        deferUpdate: async () => undefined,
      };
      return {
        resource: {
          message: {
            awaitMessageComponent: async () => {
              if (!it.click) throw new Error('timeout');
              button.customId = it.click;
              return button;
            },
          },
        },
      };
    },
    editReply: async (body: { content?: string }) => {
      replies.push(body.content ?? '');
    },
    deferReply: async () => {
      it.deferred = true;
    },
  };
  return it as unknown as FakeInteraction;
}
