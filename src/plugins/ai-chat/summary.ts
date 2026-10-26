import { formatUtc8 } from './time';
import { countChannelMessages, parseAttachments, recentChannelMessages } from './messages';

export type ChannelLine = {
  author: string;
  content: string;
  created_at: number;
  images: string[];
  images_at: number | null;
};

/**
 * 读取频道最近 count 条消息（时间从旧到新），供总结/回顾使用。
 * 数据来自统一的 messages 表（所有成员的发言 + bot 自己的发言），bot 的发言作者名后标注"（你）"。
 */
export function getRecentChannelMessages(
  _platform: string,
  channelId: string,
  count: number,
  excludeMessageId?: string
): ChannelLine[] {
  return recentChannelMessages(channelId, count, excludeMessageId).map((m) => ({
    author: m.msg_kind === 'user' ? m.author_name : `${m.author_name}（你）`,
    content: m.content_text,
    created_at: m.created_at,
    images: parseAttachments(m.attachments)
      .filter((a) => a.type.startsWith('image'))
      .map((a) => a.url),
    images_at: m.attachments_at,
  }));
}

export function getChannelMessageCount(_platform: string, channelId: string): number {
  return countChannelMessages(channelId);
}

// Discord 附件签名 URL 约 24h 过期，留 1h 余量后就不再把链接当可读图抛给模型
const FRESH_IMG_MS = 23 * 60 * 60 * 1000;
// 单次输出的图片直链总量上限，避免图片密集频道撑爆上下文
const MAX_IMG_URLS = 40;

export function formatForSummary(
  msgs: Array<{
    author: string;
    content: string;
    created_at: number;
    images?: string[];
    images_at?: number | null;
  }>
): string {
  const out: string[] = [];
  let last: string | null = null;
  let urlBudget = MAX_IMG_URLS;
  const now = Date.now();
  for (const m of msgs) {
    const text = m.content.trim();
    const imgs = (m.images || []).filter(Boolean);
    if (!text && imgs.length === 0) continue;
    // 纯图片消息也要显示出来，正文用占位提示
    const body = text || '（图片）';
    if (m.author === last) {
      // 同一作者的连续消息用 \n 续在同一组里，不再重复时间与作者名
      out.push(body);
    } else {
      // 新的作者分组：整组只在开头带一个 UTC+8 时间
      out.push(`[${formatUtc8(m.created_at)}] ${m.author}: ${body}`);
      last = m.author;
    }
    // 该条消息若带图，紧随其后标注图片直链，供模型按需用 read_image 查看
    if (imgs.length) {
      const fresh = m.images_at != null && now - m.images_at < FRESH_IMG_MS;
      if (!fresh) {
        // 链接已过期：只告知有图、不给死链，避免模型加载失败后臆测
        out.push(`[图片 ${imgs.length} 张：链接已过期，无法查看]`);
      } else if (urlBudget <= 0) {
        out.push(`[图片 ${imgs.length} 张：链接从略]`);
      } else {
        const show = imgs.slice(0, urlBudget);
        urlBudget -= show.length;
        out.push(`[图片: ${show.join(' ')}]`);
      }
    }
  }
  return out.join('\n');
}
