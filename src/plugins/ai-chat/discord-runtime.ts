import { logger } from '@/logger';
import {
  ActivityType,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageReaction,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type Presence,
  type User,
} from 'discord.js';
import { getAiConfig } from './config';
import { fixLegacyGuildIds, isChannelDenylisted, upsertChannel } from './channels';
import { setMeta } from '@/plugins/ai-chat/db/meta';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import { forgetEpoch } from './forget-guard';
import { getStoredMessage } from './messages';
import {
  channelInfoFromDiscord,
  memberInfoFromDiscord,
  renderMessage,
  toIngestMessage,
  userInfoFromDiscord,
  type IngestOverrides,
} from './discord-adapter';
import { bindLegacyIdentity, isOptedOut, markMemberLeft, pendingLegacyUsernames, upsertGuild, upsertMember, upsertUser } from './identity';
import { backfillChannelTo, enqueueHistoryTask, pageFrom, syncChannel, type SyncChannel } from './history-sync';
import { ingestDelete, ingestEdit, ingestMessage, isGuildAllowed, isIngestEnabled, recordReaction, type ReactedMessage } from './ingest';
import type { PrivilegedIntents } from '@/bots/discord-intents';
import type { IngestMessage } from './ingest';
import { applyPresence, type ActivityKind, type PresenceInfo } from './presence';

export type ReactionListener = (reacted: ReactedMessage, messageId: string, userId: string) => void;

const reactionListeners: ReactionListener[] = [];

/** 订阅"有人给已入库的消息贴表情"（主动插话的反馈统计用） */
export function onStoredMessageReaction(fn: ReactionListener): void {
  reactionListeners.push(fn);
}

function warn(what: string, e: unknown): void {
  logger.warn('Ingest', `${what}失败(忽略):`, (e as Error)?.message ?? e);
}

const TEXT_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
]);

function canReadHistory(channel: GuildBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return !!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

/**
 * 工具读别的频道的原话前的检查：回复发在当前频道、所有能看当前频道的人都会看到，所以只允许
 * 所有成员（@everyone）都能看的频道，且提问的人自己也能读；私密子区、私密频道一律不行（当前频道本身由调用方放行）。
 * 不在缓存里的频道、拿不到成员信息时一律不行。
 */
export function channelQuoteGuard(client: Client, userId: string): (channelId: string) => boolean {
  return (channelId: string): boolean => {
    const ch = client.channels.cache.get(channelId);
    if (!ch || ch.isDMBased() || ch.type === ChannelType.PrivateThread) return false;
    const member = ch.guild.members.cache.get(userId);
    if (!member) return false;
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    return !!ch.permissionsFor(ch.guild.roles.everyone)?.has(need) && !!ch.permissionsFor(member)?.has(need);
  };
}

/** 把一个可读的文字频道包装成历史同步要用的 SyncChannel */
export function syncChannelFor(channel: GuildTextBasedChannel, selfId: string): SyncChannel {
  return {
    info: channelInfoFromDiscord(channel, channel.guildId),
    fetchBefore: async (before?: string) => {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const raw: Array<{ id: string; createdAt: number }> = [];
      const messages: IngestMessage[] = [];
      for (const m of batch.values()) {
        raw.push({ id: m.id, createdAt: m.createdTimestamp });
        const im = toIngestMessage(m, selfId, 'backfill');
        if (im) messages.push(im);
      }
      return pageFrom(messages, raw);
    },
  };
}

/**
 * 模型要读的频道历史比库里多时，按需从 Discord 往前补。
 * 不进全局同步队列：启动时的全量同步可能要跑很久，工具调用不能排在它后面干等；重复拉到的消息按 ID 去重。
 */
export function backfillForTool(channel: GuildTextBasedChannel, selfId: string, target: number): Promise<number> {
  return backfillChannelTo(syncChannelFor(channel, selfId), target);
}

/** 通过 Discord 接口刷新某人的资料（"获取单个成员"不需要特权 intent）；拿不到成员时退而刷新用户 */
export async function refreshPersonFromDiscord(guild: Guild | null, userId: string): Promise<void> {
  // 退出记录的人不再自动采集资料（只有 /optin 才恢复）；每次请求返回后都再查一次退出状态和删除代次
  // （请求期间 TA /forget-me 了，返回的资料不能再写回去）
  if (isOptedOut(userId)) return;
  const epoch = forgetEpoch();
  const stillOk = (): boolean => !isOptedOut(userId) && forgetEpoch() === epoch;
  const now = Date.now();
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  if (!stillOk()) return;
  if (member) {
    const user = userInfoFromDiscord(member.user);
    upsertUser(user, now, { refreshed: true });
    upsertMember(memberInfoFromDiscord(member), user, now, { refreshed: true });
    return;
  }
  const client = guild?.client;
  const user = client ? await client.users.fetch(userId).catch(() => null) : null;
  if (user && stillOk()) upsertUser(userInfoFromDiscord(user), now, { refreshed: true });
}

/** 实时消息入库（含 bot 自己发出的消息；其他 bot 在 ingest 里被过滤） */
export function ingestLiveMessage(message: Message, selfId: string, overrides: IngestOverrides = {}): void {
  if (!message.guildId) return;
  try {
    const im = toIngestMessage(message, selfId, 'live', overrides);
    if (im) ingestMessage(im, { forceKind: overrides.kind !== undefined });
  } catch (e) {
    warn('记录消息', e);
  }
}

async function onMessageUpdate(updated: Message | PartialMessage, selfId: string): Promise<void> {
  // 已经入库的消息（关掉被动观察时也有直接对话）被编辑了就同步；没入库的不管
  if (!updated.guildId || !isAiSchemaReady() || !getStoredMessage(updated.id)) return;
  const full = updated.partial ? await updated.fetch().catch(() => null) : updated;
  if (!full) return;
  const rendered = renderMessage(full, selfId);
  ingestEdit(full.id, full.content ?? '', rendered, full.editedTimestamp ?? Date.now());
}

async function onReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot) return;
  const guildId = reaction.message.guildId;
  if (!guildId) return;
  const full = user.partial ? await user.fetch().catch(() => null) : user;
  if (!full) return;
  const reacted = recordReaction(guildId, reaction.message.id, userInfoFromDiscord(full), Date.now());
  if (!reacted) return;
  for (const fn of reactionListeners) {
    try {
      fn(reacted, reaction.message.id, full.id);
    } catch (e) {
      warn('处理表情反馈', e);
    }
  }
}

function onMemberChange(member: GuildMember): void {
  if (!isIngestEnabled() || !isGuildAllowed(member.guild.id) || isOptedOut(member.id)) return;
  const now = Date.now();
  const user = userInfoFromDiscord(member.user);
  upsertUser(user, now, { refreshed: true });
  upsertMember(memberInfoFromDiscord(member), user, now, { refreshed: true });
}

const ACTIVITY_KINDS: Record<number, ActivityKind> = {
  [ActivityType.Playing]: 'playing',
  [ActivityType.Streaming]: 'streaming',
  [ActivityType.Listening]: 'listening',
  [ActivityType.Watching]: 'watching',
  [ActivityType.Custom]: 'custom',
  [ActivityType.Competing]: 'competing',
};

export function presenceInfoFromDiscord(p: Presence): PresenceInfo {
  const status = p.status === 'invisible' ? 'offline' : p.status;
  return {
    userId: p.userId,
    status: status === 'online' || status === 'idle' || status === 'dnd' ? status : 'offline',
    devices: Object.keys(p.clientStatus ?? {}),
    activities: p.activities.map((a) => ({
      type: ACTIVITY_KINDS[a.type] ?? 'playing',
      name: a.name,
      details: a.details ?? null,
      state: a.state ?? null,
      startedAt: a.timestamps?.start ? a.timestamps.start.getTime() : null,
    })),
  };
}

function guildTextChannels(guild: Guild): GuildTextBasedChannel[] {
  const out: GuildTextBasedChannel[] = [];
  for (const ch of guild.channels.cache.values()) {
    if (!TEXT_CHANNEL_TYPES.has(ch.type) || !ch.isTextBased()) continue;
    out.push(ch as GuildTextBasedChannel);
  }
  return out;
}

async function collectThreads(guild: Guild): Promise<GuildTextBasedChannel[]> {
  const cfg = getAiConfig().history;
  if (!cfg.includeThreads) return [];
  const threads: GuildTextBasedChannel[] = [];
  try {
    const active = await guild.channels.fetchActiveThreads();
    for (const t of active.threads.values()) threads.push(t);
  } catch (e) {
    warn(`获取 ${guild.name} 的活跃子区`, e);
  }
  if (cfg.archivedThreadDays > 0) {
    const since = Date.now() - cfg.archivedThreadDays * 86400000;
    for (const ch of guild.channels.cache.values()) {
      if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildForum && ch.type !== ChannelType.GuildAnnouncement) continue;
      if (!canReadHistory(ch)) continue;
      try {
        // 按归档时间从新到旧分页，直到翻出配置的时间范围、没有更多、或者翻满 20 页
        let before: Date | undefined;
        for (let page = 0; page < 20; page++) {
          const archived = await ch.threads.fetchArchived({ limit: 50, ...(before ? { before } : {}) });
          let oldest = Infinity;
          for (const t of archived.threads.values()) {
            const at = t.archiveTimestamp ?? 0;
            oldest = Math.min(oldest, at);
            if (at >= since) threads.push(t);
          }
          if (!archived.hasMore || archived.threads.size === 0 || oldest < since) break;
          before = new Date(oldest);
          const interval = cfg.requestIntervalMs;
          if (interval > 0) await new Promise((r) => setTimeout(r, interval));
        }
      } catch {
        // 没有权限读取已归档子区时静默跳过
      }
    }
  }
  return threads;
}

/** bot 自己的账号、各服务器昵称与托管角色 */
function recordSelfIdentity(client: Client<true>): void {
  const now = Date.now();
  const self = userInfoFromDiscord(client.user);
  upsertUser(self, now, { isSelf: true, refreshed: true });
  const roleIds: string[] = [];
  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) continue;
    upsertGuild(guild.id, guild.name, now);
    const me = guild.members.me;
    if (me) upsertMember(memberInfoFromDiscord(me), self, now, { refreshed: true });
    const botRole = me?.roles.botRole;
    if (botRole) roleIds.push(botRole.id);
  }
  setMeta('bot.user_id', client.user.id);
  setMeta('bot.role_ids', JSON.stringify(roleIds));
}

/** 旧数据只记了用户名：在允许的服务器里按用户名搜一次成员，完全相同的就绑定 */
async function bindLegacyUsernames(client: Client<true>): Promise<void> {
  const names = pendingLegacyUsernames();
  if (names.length === 0) return;
  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) continue;
    for (const name of names) {
      try {
        const found = await guild.members.search({ query: name, limit: 5 });
        const exact = [...found.values()].find((m) => m.user.username === name);
        if (exact && !isOptedOut(exact.id)) {
          const now = Date.now();
          const user = userInfoFromDiscord(exact.user);
          upsertUser(user, now, { refreshed: true });
          upsertMember(memberInfoFromDiscord(exact), user, now, { refreshed: true });
          bindLegacyIdentity(exact.id, name);
        }
      } catch (e) {
        warn(`搜索旧用户 ${name}`, e);
      }
    }
  }
}

async function fetchAllMembers(guild: Guild): Promise<void> {
  try {
    const members = await guild.members.fetch();
    const now = Date.now();
    for (const m of members.values()) {
      if (isOptedOut(m.id)) continue;
      const user = userInfoFromDiscord(m.user);
      upsertUser(user, now, { refreshed: true });
      upsertMember(memberInfoFromDiscord(m), user, now, { refreshed: true });
    }
    logger.info('Ingest', `已同步 ${guild.name} 的 ${members.size} 名成员资料`);
  } catch (e) {
    warn(`拉取 ${guild.name} 的成员列表`, e);
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;

/** 启动和断线重连（新会话）后执行一次：身份、频道、旧数据修复、成员、历史补全。多次触发会合并。 */
export function scheduleStartupSync(client: Client, privileged: PrivilegedIntents, reason: string): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (syncing || !client.isReady()) return;
    syncing = true;
    runStartupSync(client, privileged, reason)
      .catch((e) => warn('启动同步', e))
      .finally(() => {
        syncing = false;
      });
  }, 3000);
}

async function runStartupSync(client: Client<true>, privileged: PrivilegedIntents, reason: string): Promise<void> {
  if (!isIngestEnabled()) return;
  const selfId = client.user.id;
  recordSelfIdentity(client);

  const channels: GuildTextBasedChannel[] = [];
  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) continue;
    for (const ch of guildTextChannels(guild)) {
      upsertChannel(channelInfoFromDiscord(ch, guild.id));
      fixLegacyGuildIds(ch.id, guild.id);
      if (canReadHistory(ch)) channels.push(ch);
    }
    if (privileged.members) await fetchAllMembers(guild);
    for (const t of await collectThreads(guild)) {
      upsertChannel(channelInfoFromDiscord(t, guild.id));
      if (canReadHistory(t)) channels.push(t);
    }
  }
  await bindLegacyUsernames(client);

  if (!getAiConfig().history.gapFillOnStartup) return;
  const denylist = getAiConfig().memory.observe.channelDenylist;
  // 与入库用同一个判断：子区 → 父频道 → 分类，任何一级在黑名单里都不回望
  const targets = channels.filter((c) => !isChannelDenylisted(c.id, c.parentId ?? null, denylist, channelInfoFromDiscord(c, c.guildId).categoryId));
  logger.info('History', `${reason}：开始同步 ${targets.length} 个频道的历史消息`);
  let inserted = 0;
  for (const ch of targets) {
    await enqueueHistoryTask(async () => {
      try {
        const r = await syncChannel(syncChannelFor(ch, selfId));
        inserted += r.inserted;
        if (r.inserted > 0) {
          logger.info('History', `#${ch.name}：${r.mode === 'initial' ? '首次回望' : '补缺口'} ${r.pages} 页，新增 ${r.inserted} 条`);
        }
      } catch (e) {
        warn(`同步 #${ch.name} 的历史`, e);
      }
    });
  }
  logger.info('History', `同步完成，共新增 ${inserted} 条消息`);
}

/** 把入库相关的事件挂到 Discord 客户端上（聊天回复的 messageCreate 处理在 bots/discord.ts） */
export function attachIngestHandlers(client: Client, privileged: PrivilegedIntents): void {
  client.on('messageUpdate', (_old, updated) => {
    const selfId = client.user?.id;
    if (!selfId) return;
    onMessageUpdate(updated, selfId).catch((e) => warn('记录消息编辑', e));
  });
  client.on('messageDelete', (m) => {
    try {
      ingestDelete(m.id);
    } catch (e) {
      warn('同步删除消息', e);
    }
  });
  client.on('messageDeleteBulk', (msgs) => {
    try {
      for (const id of msgs.keys()) ingestDelete(id);
    } catch (e) {
      warn('同步批量删除消息', e);
    }
  });
  client.on('messageReactionAdd', (reaction, user) => {
    onReactionAdd(reaction, user).catch((e) => warn('记录表情反应', e));
  });

  if (privileged.members) {
    client.on('guildMemberAdd', (m) => {
      try {
        onMemberChange(m);
      } catch (e) {
        warn('记录新成员', e);
      }
    });
    client.on('guildMemberUpdate', (_old, m) => {
      try {
        onMemberChange(m);
      } catch (e) {
        warn('记录成员资料变化', e);
      }
    });
    client.on('guildMemberRemove', (m: GuildMember | PartialGuildMember) => {
      try {
        if (isIngestEnabled() && isGuildAllowed(m.guild.id)) markMemberLeft(m.guild.id, m.id, Date.now());
      } catch (e) {
        warn('记录成员离开', e);
      }
    });
  }

  if (privileged.presences) {
    client.on('presenceUpdate', (_old, p) => {
      try {
        if (!p.guild || !isGuildAllowed(p.guild.id) || !isIngestEnabled()) return;
        applyPresence(presenceInfoFromDiscord(p));
      } catch (e) {
        warn('记录在线状态', e);
      }
    });
  }

  client.on('shardReady', () => scheduleStartupSync(client, privileged, '连接就绪'));
  if (client.isReady()) scheduleStartupSync(client, privileged, '启动');
}
