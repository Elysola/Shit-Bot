import { getDatabase } from '../../storage';
import { getChannelName } from '../channels';
import { topActivities } from '../presence';

export type UserStats = {
  messages: number;
  firstSeen: number | null;
  lastSeen: number | null;
  activeDays: number;
  /** 24 小时（UTC+8）发言分布 */
  hours: number[];
  /** 周一…周日（UTC+8） */
  weekdays: number[];
  /** 最活跃的连续 4 小时，如 "22:00–02:00" */
  peak: string | null;
  topChannels: Array<{ id: string; name: string; count: number }>;
  topPartners: Array<{ id: string; name: string; score: number }>;
  avgLen: number;
  images: number;
  links: number;
  topDomains: string[];
  /** 最近 30 天的活动时长（需要在线状态权限） */
  activities: Array<{ type: string; name: string; hours: number }>;
};

const UTC8 = 8 * 3600_000;
const pad = (n: number): string => String(n).padStart(2, '0');

/** 找出发言最集中的连续 4 小时（环形）；发言太少或分布太平时返回 null */
export function peakWindow(hours: number[]): string | null {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 20) return null;
  let best = -1;
  let bestStart = 0;
  for (let s = 0; s < 24; s++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += hours[(s + k) % 24];
    if (sum > best) {
      best = sum;
      bestStart = s;
    }
  }
  // 4 小时占比不到 30%（均匀分布约 17%）就不算有明显作息
  if (best / total < 0.3) return null;
  return `${pad(bestStart)}:00–${pad((bestStart + 4) % 24)}:00`;
}

/** 从库里聚合一个人的行为统计；guildId 为 null 时统计所有服务器 */
export function computeUserStats(userId: string, guildId: string | null, now: number = Date.now()): UserStats {
  const db = getDatabase();
  const rows = db
    .query(
      `SELECT created_at, channel_id, content_text, attachments FROM messages
       WHERE author_id = ? AND msg_kind = 'user' ${guildId ? 'AND guild_id = ?' : ''}`
    )
    .all(...(guildId ? [userId, guildId] : [userId])) as Array<{ created_at: number; channel_id: string; content_text: string; attachments: string | null }>;

  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  const days = new Set<string>();
  const channels = new Map<string, number>();
  const domains = new Map<string, number>();
  let chars = 0;
  let images = 0;
  let links = 0;
  let first: number | null = null;
  let last: number | null = null;

  for (const r of rows) {
    const d = new Date(r.created_at + UTC8);
    hours[d.getUTCHours()]++;
    weekdays[(d.getUTCDay() + 6) % 7]++;
    days.add(d.toISOString().slice(0, 10));
    channels.set(r.channel_id, (channels.get(r.channel_id) ?? 0) + 1);
    chars += [...r.content_text].length;
    if (r.attachments && r.attachments.includes('"image')) images++;
    for (const m of r.content_text.matchAll(/https?:\/\/([^/\s?#]+)/g)) {
      links++;
      const host = m[1].toLowerCase().replace(/^www\./, '');
      domains.set(host, (domains.get(host) ?? 0) + 1);
    }
    first = first === null ? r.created_at : Math.min(first, r.created_at);
    last = last === null ? r.created_at : Math.max(last, r.created_at);
  }

  const partners = db
    .query(
      `SELECT other, SUM(score) AS score FROM (
         SELECT to_user_id AS other, mentions * 2 + replies * 2 + reactions AS score FROM interaction_edges
         WHERE from_user_id = ? ${guildId ? 'AND guild_id = ?' : ''}
         UNION ALL
         SELECT from_user_id AS other, mentions * 2 + replies * 2 + reactions AS score FROM interaction_edges
         WHERE to_user_id = ? ${guildId ? 'AND guild_id = ?' : ''}
       ) GROUP BY other ORDER BY score DESC LIMIT 8`
    )
    .all(...(guildId ? [userId, guildId, userId, guildId] : [userId, userId])) as Array<{ other: string; score: number }>;
  const nameOf = (id: string): string => {
    const row = db
      .query(
        `SELECT COALESCE((SELECT display_name FROM guild_members WHERE user_id = u.user_id ${guildId ? 'AND guild_id = ?' : ''} LIMIT 1),
                         u.global_name, u.username) AS n, u.is_self AS s FROM users u WHERE u.user_id = ?`
      )
      .get(...(guildId ? [guildId, id] : [id])) as { n: string; s: number } | null;
    return row ? (row.s ? `${row.n}（你）` : row.n) : id;
  };

  return {
    messages: rows.length,
    firstSeen: first,
    lastSeen: last,
    activeDays: days.size,
    hours,
    weekdays,
    peak: peakWindow(hours),
    topChannels: [...channels.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ id, name: getChannelName(id) ?? id, count })),
    topPartners: partners.filter((p) => p.score > 0).map((p) => ({ id: p.other, name: nameOf(p.other), score: p.score })),
    avgLen: rows.length ? Math.round((chars / rows.length) * 10) / 10 : 0,
    images,
    links,
    topDomains: [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d]) => d),
    activities: topActivities(userId, 30, 5, now),
  };
}

export function saveUserStats(userId: string, guildId: string, stats: UserStats, now: number = Date.now()): void {
  getDatabase().run(
    `INSERT INTO user_stats (user_id, guild_id, stats, computed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, guild_id) DO UPDATE SET stats = excluded.stats, computed_at = excluded.computed_at`,
    [userId, guildId, JSON.stringify(stats), now]
  );
}

export function getSavedUserStats(userId: string, guildId: string): (UserStats & { computedAt: number }) | null {
  const row = getDatabase().query('SELECT stats, computed_at FROM user_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId) as
    | { stats: string; computed_at: number }
    | null;
  if (!row) return null;
  try {
    return { ...(JSON.parse(row.stats) as UserStats), computedAt: row.computed_at };
  } catch {
    return null;
  }
}

const WEEKDAY = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const ACTIVITY_VERB: Record<string, string> = { playing: '玩', listening: '听', watching: '看', streaming: '直播', competing: '比赛' };

/** 统计 → 几行可读文本（get_person 与画像生成用） */
export function describeStats(s: UserStats): string[] {
  if (s.messages === 0) return ['还没有发言记录。'];
  const lines: string[] = [];
  const date = (t: number | null): string => (t ? new Date(t + UTC8).toISOString().slice(0, 10) : '?');
  lines.push(`发言 ${s.messages} 条，活跃 ${s.activeDays} 天（${date(s.firstSeen)} 至 ${date(s.lastSeen)}），平均每条 ${s.avgLen} 字`);
  if (s.peak) lines.push(`最常在 ${s.peak}（UTC+8）发言`);
  const topDay = s.weekdays.indexOf(Math.max(...s.weekdays));
  if (s.messages >= 20) lines.push(`最活跃的是${WEEKDAY[topDay]}`);
  if (s.topChannels.length) lines.push(`常去的频道：${s.topChannels.map((c) => `#${c.name}(${c.count})`).join('、')}`);
  if (s.topPartners.length) lines.push(`互动最多的人：${s.topPartners.slice(0, 5).map((p) => p.name).join('、')}`);
  if (s.images || s.links) lines.push(`发过 ${s.images} 张图、${s.links} 个链接${s.topDomains.length ? `（常见：${s.topDomains.join('、')}）` : ''}`);
  if (s.activities.length) {
    lines.push(`最近 30 天：${s.activities.map((a) => `${ACTIVITY_VERB[a.type] ?? ''}${a.name} ${a.hours} 小时`).join('、')}`);
  }
  return lines;
}
