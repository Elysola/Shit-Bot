import type { Message, TextChannel } from 'discord.js';

/** 持续显示"正在输入"，返回停止函数 */
export function startTyping(channel: TextChannel): () => void {
  const send = () => {
    channel.sendTyping().catch(() => {});
  };
  send();
  const timer = setInterval(send, 8000);
  return () => clearInterval(timer);
}

/** 按 1900 字切分（尽量在换行处断开） */
export function chunkText(text: string, maxLen = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf('\n');
    if (remaining.length > maxLen && lastNewline > maxLen / 2) {
      chunk = remaining.slice(0, lastNewline);
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

/**
 * 发送 AI 的回复：asReply=true 时回复某条消息（不提醒对方），否则直接发到频道。
 * 只允许提醒 mentionUserIds 里的人（@everyone、角色一律不提醒）。返回实际发出的消息（用于入库）。
 */
export async function sendAiText(target: Message, text: string, mentionUserIds: string[], asReply = true): Promise<Message[]> {
  const chunks = chunkText(text);
  const sent: Message[] = [];
  const allowedMentions = { repliedUser: false, parse: [] as [], users: mentionUserIds };
  try {
    for (const chunk of chunks) {
      // 与原来的行为一致：每一段都回复同一条消息；不回复时每段都直接发到频道
      const m = asReply
        ? await target.reply({ content: chunk, allowedMentions })
        : await (target.channel as TextChannel).send({ content: chunk, allowedMentions });
      sent.push(m);
      if (chunks.length > 1) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('Discord AI 回复发送失败:', error);
  }
  return sent;
}
