import { emojify } from 'node-emoji';

export interface ReplyPayload {
  reply: string;
  reactions: string[];
  /** 本轮上下文/工具结果里出现过的用户 ID：回复里写 <@ID> 时只允许提醒这些人 */
  mentionableIds?: string[];
}

const ALIAS: Record<string, string> = {
  thumbsup: '👍',
  thumbsdown: '👎',
  '+1': '👍',
  '-1': '👎',
};

function resolveEmoji(s: string): string | null {
  const t = String(s || '').trim();
  if (!t) return null;
  if (t.startsWith(':') && t.endsWith(':') && t.length > 2) {
    const name = t.slice(1, -1).toLowerCase();
    if (ALIAS[name]) return ALIAS[name];
    const e = emojify(`:${name}:`);
    return e !== `:${name}:` ? e : null;
  }
  // 裸 Unicode emoji: 含非 ASCII 字符且较短才接受，避免把普通文字当表情
  if (/[^\p{ASCII}]/u.test(t) && t.length <= 16) return t;
  return null;
}

export function resolveReactions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const e = resolveEmoji(item as string);
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= 5) break;
  }
  return out;
}

// 从可能被截断的 JSON 里尽量抽出 reply 字段的文本（截断时 JSON 解析不了，用这个兜底）
export function salvageReply(text: string): string {
  const t = String(text || '');
  const m = t.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    try {
      return JSON.parse('"' + m[1] + '"');
    } catch {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }
  // 没有可抽取的 reply 字段：像 JSON 的残骸(无意义的 {...}) 返回空交给上层兜底，否则当作纯文本
  return /^\s*[{[]/.test(t) ? '' : t;
}

export function parseReplyJson(text: string): ReplyPayload | null {
  let t = String(text || '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (typeof obj.reply !== 'string' || !obj.reply.trim()) return null;
    return { reply: obj.reply, reactions: resolveReactions(obj.reactions) };
  } catch {
    return null;
  }
}
