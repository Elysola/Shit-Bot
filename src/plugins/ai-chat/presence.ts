import { getDatabase, getDatabaseGeneration } from '@/storage';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import { getUser, isOptedOut } from './identity';

export type ActivityKind = 'playing' | 'streaming' | 'listening' | 'watching' | 'custom' | 'competing';

export type ActivityInfo = {
  type: ActivityKind;
  name: string;
  details: string | null;
  state: string | null;
  startedAt: number | null;
};

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export type PresenceInfo = {
  userId: string;
  status: PresenceStatus;
  /** 'desktop' | 'mobile' | 'web' */
  devices: string[];
  activities: ActivityInfo[];
};

type OpenSession = { userId: string; type: ActivityKind; name: string; details: string | null; startedAt: number };

// 短于 5 分钟的活动不记（切歌、短暂打开游戏启动器之类）
const MIN_SESSION_MS = 5 * 60 * 1000;

let generation = -1;
const current = new Map<string, { info: PresenceInfo; updatedAt: number }>();
const openSessions = new Map<string, OpenSession>();

function ensureFresh(): void {
  const g = getDatabaseGeneration();
  if (g === generation) return;
  current.clear();
  openSessions.clear();
  generation = g;
}

function sessionKey(userId: string, type: ActivityKind, name: string): string {
  return `${userId}\u0000${type}\u0000${name}`;
}

function closeSession(s: OpenSession, endAt: number): void {
  // 中途 /optout 的人：未结束的活动不再落库
  if (endAt - s.startedAt < MIN_SESSION_MS || !isAiSchemaReady() || isOptedOut(s.userId)) return;
  getDatabase().run('INSERT INTO activity_sessions (user_id, type, name, details, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)', [
    s.userId,
    s.type,
    s.name,
    s.details,
    s.startedAt,
    endAt,
  ]);
}

/**
 * 处理一次在线状态更新（同一个人在多个服务器会收到重复事件，这里按人去重，幂等）。
 * 只跟踪库里已经认识、且没有 optout 的用户。
 */
export function applyPresence(info: PresenceInfo, now: number = Date.now()): void {
  ensureFresh();
  if (!isAiSchemaReady() || !getUser(info.userId) || isOptedOut(info.userId)) return;

  const active = info.status === 'offline' ? [] : info.activities.filter((a) => a.type !== 'custom' && a.name);
  const keysNow = new Set<string>();
  for (const a of active) {
    const key = sessionKey(info.userId, a.type, a.name);
    keysNow.add(key);
    if (!openSessions.has(key)) {
      const startedAt = a.startedAt && a.startedAt <= now ? a.startedAt : now;
      openSessions.set(key, { userId: info.userId, type: a.type, name: a.name, details: a.details, startedAt });
    }
  }
  for (const [key, s] of openSessions) {
    if (s.userId === info.userId && !keysNow.has(key)) {
      closeSession(s, now);
      openSessions.delete(key);
    }
  }

  if (info.status === 'offline') current.delete(info.userId);
  else current.set(info.userId, { info, updatedAt: now });
}

/** 进程退出前把进行中的活动记下来 */
export function flushPresenceSessions(now: number = Date.now()): void {
  ensureFresh();
  for (const s of openSessions.values()) closeSession(s, now);
  openSessions.clear();
}

/** /forget-me：丢掉这个人当前的在线状态和未结束的活动（不写库） */
export function forgetPresence(userId: string): void {
  ensureFresh();
  current.delete(userId);
  for (const [key, s] of openSessions) if (s.userId === userId) openSessions.delete(key);
}

export function getPresence(userId: string): PresenceInfo | null {
  ensureFresh();
  return current.get(userId)?.info ?? null;
}

const STATUS_LABEL: Record<PresenceStatus, string> = { online: '在线', idle: '离开', dnd: '请勿打扰', offline: '离线' };
const DEVICE_LABEL: Record<string, string> = { desktop: '电脑', mobile: '手机', web: '网页' };
const VERB: Record<ActivityKind, string> = {
  playing: '正在玩',
  streaming: '正在直播',
  listening: '正在听',
  watching: '正在看',
  competing: '正在比赛',
  custom: '状态',
};

/** 当前状态的一句话描述，例如 "在线（手机）· 正在玩 原神 · 状态：摸鱼中"；没有在线状态数据时返回 null */
export function describePresence(userId: string): string | null {
  const p = getPresence(userId);
  if (!p) return null;
  const parts: string[] = [];
  const devices = p.devices.map((d) => DEVICE_LABEL[d] ?? d).join('/');
  parts.push(devices ? `${STATUS_LABEL[p.status]}（${devices}）` : STATUS_LABEL[p.status]);
  for (const a of p.activities.slice(0, 3)) {
    if (a.type === 'custom') {
      if (a.state) parts.push(`状态：${a.state.slice(0, 60)}`);
      continue;
    }
    const extra = a.type === 'listening' && a.details ? `《${a.details.slice(0, 40)}》` : '';
    parts.push(`${VERB[a.type]} ${a.name.slice(0, 40)}${extra}`);
  }
  return parts.join(' · ');
}

/** 最近 days 天里时长最多的活动（给统计和画像用） */
export function topActivities(userId: string, days: number, limit = 5, now: number = Date.now()): Array<{ type: string; name: string; hours: number }> {
  if (!isAiSchemaReady()) return [];
  const rows = getDatabase()
    .query(
      `SELECT type, name, SUM(ended_at - started_at) AS ms FROM activity_sessions
       WHERE user_id = ? AND ended_at >= ? GROUP BY type, name ORDER BY ms DESC LIMIT ?`
    )
    .all(userId, now - days * 86400000, limit) as Array<{ type: string; name: string; ms: number }>;
  return rows.map((r) => ({ type: r.type, name: r.name, hours: Math.round((r.ms / 3600000) * 10) / 10 }));
}
