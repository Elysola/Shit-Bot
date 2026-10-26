import { getDatabase } from '@/storage';

export type ChannelInfo = {
  channelId: string;
  guildId: string;
  parentId: string | null;
  name: string | null;
  /** 'text' | 'thread' | 'forum' | 'voice' | 'announcement' | … */
  type: string;
  /** 子区所在的分类（父频道的父级）；不入库，只用于黑名单判断 */
  categoryId?: string | null;
};

export type ChannelRow = {
  channel_id: string;
  guild_id: string;
  parent_id: string | null;
  name: string | null;
  type: string;
  readable: number;
  newest_message_id: string | null;
  oldest_message_id: string | null;
  history_complete: number;
  history_exhausted: number;
  last_gapfill_at: number | null;
  last_backfill_at: number | null;
  proactive_bias: number;
  last_bot_message_at: number | null;
  quiet_until: number | null;
  updated_at: number;
};

export function upsertChannel(c: ChannelInfo, now: number = Date.now()): void {
  getDatabase().run(
    `INSERT INTO channels (channel_id, guild_id, parent_id, name, type, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id, parent_id = excluded.parent_id,
       name = COALESCE(excluded.name, channels.name), type = excluded.type, updated_at = excluded.updated_at`,
    [c.channelId, c.guildId, c.parentId, c.name, c.type, now]
  );
  // 子区 / 论坛帖：顺带记下父频道属于哪个分类。论坛频道本身不会单独同步，
  // 提炼时按"帖子 → 父频道 → 分类"判断黑名单要靠这条记录
  if (c.parentId && c.categoryId) {
    getDatabase().run(
      `INSERT INTO channels (channel_id, guild_id, parent_id, name, type, updated_at) VALUES (?, ?, ?, NULL, 'unknown', ?)
       ON CONFLICT(channel_id) DO UPDATE SET parent_id = COALESCE(channels.parent_id, excluded.parent_id)`,
      [c.parentId, c.guildId, c.categoryId, now]
    );
  }
}

export function getChannel(channelId: string): ChannelRow | null {
  return getDatabase().query('SELECT * FROM channels WHERE channel_id = ?').get(channelId) as ChannelRow | null;
}

export function getChannelName(channelId: string): string | null {
  const row = getDatabase().query('SELECT name FROM channels WHERE channel_id = ?').get(channelId) as { name: string | null } | null;
  return row?.name ?? null;
}

export type ChannelSyncPatch = Partial<{
  newest_message_id: string | null;
  oldest_message_id: string | null;
  history_complete: boolean;
  history_exhausted: boolean;
  last_gapfill_at: number;
  last_backfill_at: number;
  readable: boolean;
}>;

export function updateChannelSync(channelId: string, patch: ChannelSyncPatch, now: number = Date.now()): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null));
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now, channelId);
  getDatabase().run(`UPDATE channels SET ${sets.join(', ')} WHERE channel_id = ?`, params);
}

/** 旧版迁移过来的消息不知道属于哪个服务器；知道频道归属后补上 */
export function fixLegacyGuildIds(channelId: string, guildId: string): number {
  return getDatabase().run("UPDATE messages SET guild_id = ? WHERE channel_id = ? AND guild_id = ''", [guildId, channelId]).changes;
}

export function markBotMessage(channelId: string, at: number): void {
  getDatabase().run('UPDATE channels SET last_bot_message_at = MAX(COALESCE(last_bot_message_at, 0), ?) WHERE channel_id = ?', [
    at,
    channelId,
  ]);
}

/**
 * 频道是否在采集黑名单里。按整条祖先链判断：子区 → 父频道 → 分类，所以把分类加进黑名单时它下面频道里的子区也不观察。
 * categoryId 不传时从库里查父频道的父级。
 */
export function isChannelDenylisted(channelId: string, parentId: string | null, denylist: readonly string[], categoryId?: string | null): boolean {
  if (denylist.length === 0) return false;
  if (denylist.includes(channelId) || (!!parentId && denylist.includes(parentId))) return true;
  if (!parentId) return false;
  const grand = categoryId ?? (getDatabase().query('SELECT parent_id FROM channels WHERE channel_id = ?').get(parentId) as { parent_id: string | null } | null)?.parent_id;
  return !!grand && denylist.includes(grand);
}
