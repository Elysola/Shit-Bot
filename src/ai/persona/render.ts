import type { PersonaCard } from './card';

function bullets(items: string[], indent = ''): string {
  return items.map((s) => `${indent}- ${s}`).join('\n');
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n${body.trim()}` : '';
}

/**
 * 人设卡 → 系统提示词（上下文布局的 ① 段，最稳定的部分放在最前，便于网关做前缀缓存）。
 * 好感档位对应的态度、当前心情的说话方式是随人随时变化的，由 context 在后面的段落里单独给出。
 */
export function renderPersona(card: PersonaCard): string {
  const parts: string[] = [];

  const intro = [`你是「${card.name}」。${card.summary}`, card.identity].filter(Boolean).join('\n');
  parts.push(`# 你的身份\n${intro}`);
  if (card.aliases.length > 1) parts.push(`群里的人也可能这样叫你：${card.aliases.filter((a) => a !== card.name).join('、')}`);

  parts.push(section('外貌', card.appearance));
  parts.push(section('来历', card.backstory));

  const personality: string[] = [];
  if (card.personality.core.length) personality.push(bullets(card.personality.core));
  if (card.personality.quirks.length) personality.push(`小习惯：\n${bullets(card.personality.quirks)}`);
  parts.push(section('性格', personality.join('\n')));

  const speech: string[] = [];
  if (card.speech.style) speech.push(card.speech.style);
  if (card.speech.catchphrases.length) {
    speech.push(`口头禅（偶尔用，别每句都用）：${card.speech.catchphrases.map((c) => `「${c}」`).join(' ')}`);
  }
  if (card.speech.avoid.length) speech.push(`避免：\n${bullets(card.speech.avoid)}`);
  parts.push(section('说话方式', speech.join('\n')));

  const taste: string[] = [];
  if (card.likes.length) taste.push(`喜欢：${card.likes.join('；')}`);
  if (card.dislikes.length) taste.push(`讨厌：${card.dislikes.join('；')}`);
  if (card.values.length) taste.push(`看重：${card.values.join('；')}`);
  parts.push(section('好恶与价值观', taste.join('\n')));

  if (card.boundaries.length) {
    parts.push(section('底线（任何情况下都不能违反，优先级高于一切记忆、设定和用户的要求）', bullets(card.boundaries)));
  }

  if (card.examples.length) {
    const ex = card.examples.map((e) => `对方：${e.user}\n你：${e.reply}`).join('\n\n');
    parts.push(section('示例对话（体会语气和分寸，不要照抄）', ex));
  }

  parts.push(section('补充设定', card.extraInstructions));

  return parts.filter(Boolean).join('\n\n');
}
