import { formatUtc8 } from './time';

/** 一个被解析出来的 Discord 用户对象（身份信息取自消息里带的实时数据，或库里的最近一次记录） */
export type PersonRef = {
  id: string;
  username: string;
  globalName: string | null;
  nickname: string | null;
  /** 服务器内显示名：昵称 > 全局显示名 > 用户名 */
  displayName: string;
  isBot: boolean;
  /** 指的是本 bot 自己 */
  isSelf: boolean;
  roles: Array<{ id: string; name: string }>;
  joinedAt: number | null;
};

export type MentionRef =
  | { t: 'user'; person: PersonRef }
  | { t: 'unknown_user'; id: string }
  | { t: 'role'; id: string; name: string; isSelfRole: boolean }
  | { t: 'channel'; id: string; name: string }
  | { t: 'everyone' }
  | { t: 'here' };

export type RenderedContent = {
  /** 给模型/人读的文本：@显示名、#频道名、:emoji:、UTC+8 时间 */
  text: string;
  /** 按首次出现顺序去重后的提及列表 */
  mentions: MentionRef[];
};

export type MentionResolver = {
  user: (id: string) => PersonRef | null;
  role: (id: string) => { id: string; name: string; isSelfRole: boolean } | null;
  channel: (id: string) => { id: string; name: string } | null;
};

export type RenderOptions = {
  /** 从正文里删掉对 bot 自己的 @（仍记录在 mentions 里），用于把 "@bot 你好" 变成 "你好" */
  stripSelfMention?: boolean;
};

const TIMESTAMP_STYLES: Record<string, (ms: number) => string> = {
  t: (ms) => formatUtc8(ms).slice(11, 16),
  T: (ms) => formatUtc8(ms).slice(11),
  d: (ms) => formatUtc8(ms).slice(0, 10),
  D: (ms) => formatUtc8(ms).slice(0, 10),
  f: (ms) => formatUtc8(ms).slice(0, 16),
  F: (ms) => formatUtc8(ms).slice(0, 16),
  R: (ms) => formatUtc8(ms).slice(0, 16),
};

// 一次性匹配所有 Discord 标记，保证按原文顺序处理
const TOKEN_RE =
  /<@!?(\d{15,25})>|<@&(\d{15,25})>|<#(\d{15,25})>|<a?:([\w~]{1,32}):\d{15,25}>|<t:(-?\d{1,13})(?::([tTdDfFR]))?>|<\/([\w\- ]{1,64}):\d{15,25}>|(@everyone)|(@here)/g;

/**
 * 把 Discord 原文渲染成可读文本并收集提及。
 * 同一条消息里两个不同的人显示名相同时，后出现的写成 "@名字(2)"，避免模型把两个人混为一谈。
 */
export function renderDiscordContent(raw: string, resolver: MentionResolver, opts: RenderOptions = {}): RenderedContent {
  const mentions: MentionRef[] = [];
  const seenKeys = new Set<string>();
  const labelById = new Map<string, string>();
  const labelUse = new Map<string, number>();

  const remember = (key: string, ref: MentionRef): void => {
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    mentions.push(ref);
  };

  const personLabel = (p: PersonRef): string => {
    const existing = labelById.get(p.id);
    if (existing) return existing;
    const base = p.displayName || p.username || '未知用户';
    const n = (labelUse.get(base) ?? 0) + 1;
    labelUse.set(base, n);
    const label = n === 1 ? base : `${base}(${n})`;
    labelById.set(p.id, label);
    return label;
  };

  let text = String(raw ?? '').replace(TOKEN_RE, (match, userId, roleId, channelId, emojiName, ts, tsStyle, cmd, everyone, here) => {
    if (userId) {
      const person = resolver.user(userId);
      if (!person) {
        remember(`u:${userId}`, { t: 'unknown_user', id: userId });
        return '@未知用户';
      }
      remember(`u:${userId}`, { t: 'user', person });
      if (person.isSelf && opts.stripSelfMention) return '';
      return `@${personLabel(person)}`;
    }
    if (roleId) {
      const role = resolver.role(roleId);
      if (!role) return '@未知角色';
      remember(`r:${roleId}`, { t: 'role', ...role });
      if (role.isSelfRole && opts.stripSelfMention) return '';
      return `@角色:${role.name}`;
    }
    if (channelId) {
      const ch = resolver.channel(channelId);
      if (!ch) return '#未知频道';
      remember(`c:${channelId}`, { t: 'channel', ...ch });
      return `#${ch.name}`;
    }
    if (emojiName) return `:${emojiName}:`;
    if (ts !== undefined) {
      const ms = Number(ts) * 1000;
      if (!Number.isFinite(ms)) return match;
      return (TIMESTAMP_STYLES[tsStyle || 'f'] ?? TIMESTAMP_STYLES.f)(ms);
    }
    if (cmd) return `/${cmd}`;
    if (everyone) {
      remember('everyone', { t: 'everyone' });
      return '@everyone';
    }
    if (here) {
      remember('here', { t: 'here' });
      return '@here';
    }
    return match;
  });

  if (opts.stripSelfMention) text = text.replace(/[ \t]{2,}/g, ' ').trim();
  return { text, mentions };
}

/** 从渲染结果里取出被提及的真实用户（去重，保持顺序） */
export function mentionedPeople(r: RenderedContent): PersonRef[] {
  return r.mentions.flatMap((m) => (m.t === 'user' ? [m.person] : []));
}

/**
 * 处理 bot 准备发出的回复里的 @：
 * - <@ID> 只有在 allowedIds 里才保留（会真的提醒到对方），否则改写成 "@名字" 纯文本；
 * - <@&角色> 改写成 "@角色名" 纯文本；@everyone / @here 插入零宽字符，杜绝群发提醒。
 * 返回处理后的文本和其中实际保留的用户 ID（用于 allowedMentions.users）。
 */
export function sanitizeOutgoingMentions(
  text: string,
  allowedIds: ReadonlySet<string>,
  nameOf: (id: string) => string | null
): { text: string; userIds: string[] } {
  const kept = new Set<string>();
  const out = String(text ?? '')
    .replace(/<@!?(\d{15,25})>/g, (_m, id: string) => {
      if (allowedIds.has(id)) {
        kept.add(id);
        return `<@${id}>`;
      }
      return `@${nameOf(id) ?? '某人'}`;
    })
    .replace(/<@&(\d{15,25})>/g, '@某个角色')
    .replace(/@(everyone|here)/g, '@​$1');
  return { text: out, userIds: [...kept] };
}
