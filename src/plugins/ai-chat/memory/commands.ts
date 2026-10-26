import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { defineAiCommand, replyEphemeral } from '@/plugins/ai-chat/command-registry';
import { userInfoFromDiscord } from '@/plugins/ai-chat/discord-adapter';
import { upsertUser } from '@/plugins/ai-chat/identity';
import { personaForGuild } from '@/plugins/ai-chat/persona/loader';
import { addressOf, memoryLine } from './dossier';
import { forbiddenReason, looksSensitive } from './sensitive';
import { activeSlot, addMemory, deleteMemory, deleteMemoryChain, getMemory, listMemories, type MemoryRow } from './store';

const ADDRESS_SOURCE: Record<string, string> = {
  preferred: '你要求的',
  nickname: '你的服务器昵称',
  global: '你的显示名',
  username: '你的用户名',
};

function personaName(guildId: string | null): string {
  return personaForGuild(guildId)?.name ?? 'bot';
}

/** 用户关于自己的全部记忆，渲染成一份 Markdown */
export function renderOwnMemories(userId: string, guildId: string | null): { text: string; count: number } {
  const addr = addressOf(userId, guildId, { includeSensitive: true });
  const own = listMemories({ scope: 'user', subjectId: userId, includeSensitive: true, limit: 1000 });
  const relations = listMemories({ scope: 'relation', subjectId: userId, includeSensitive: true, limit: 200 });
  const pinned = own.filter((m) => m.pinned);
  const rest = own.filter((m) => !m.pinned);
  const line = (m: MemoryRow): string => `- ${memoryLine(m, guildId, { withId: true, withKind: true })}${m.sensitive ? ' 〔敏感，只在和你聊天时使用〕' : ''}`;

  const out: string[] = [`# ${personaName(guildId)} 关于你的记忆`, ''];
  out.push(`称呼：${addr.address}（${ADDRESS_SOURCE[addr.source]}）`);
  if (addr.aliases.length) out.push(`群里对你的叫法：${addr.aliases.map((a) => (a.by ? `${a.value}（${a.by}）` : a.value)).join('、')}`);
  out.push('');
  if (pinned.length) out.push('## 核心（每次聊天都会想起）', ...pinned.map(line), '');
  if (rest.length) out.push('## 档案', ...rest.map(line), '');
  if (relations.length) out.push('## 你和别人的关系', ...relations.map(line), '');
  const count = own.length + relations.length;
  if (count === 0) out.push('还没有关于你的记忆。');
  out.push(`共 ${count} 条。用 /forget id:<编号> 删除某一条，用 /callme 设定称呼，用 /forget-me 删除全部数据，用 /optout 停止记录。`);
  return { text: out.join('\n'), count };
}

async function onMemory(interaction: ChatInputCommandInteraction): Promise<void> {
  upsertUser(userInfoFromDiscord(interaction.user), Date.now());
  const { text, count } = renderOwnMemories(interaction.user.id, interaction.guildId);
  if (text.length <= 1900) {
    await replyEphemeral(interaction, text);
    return;
  }
  const file = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: 'memories.md' });
  await interaction.reply({
    content: `关于你的记忆共 ${count} 条，内容较多，放在附件里了（只有你能看到）。`,
    files: [file],
    flags: MessageFlags.Ephemeral,
  });
}

/** 这条记忆是不是关于该用户的（本人的记忆，或该用户参与的关系） */
export function isOwnMemory(row: MemoryRow, userId: string): boolean {
  if (row.scope === 'user') return row.subject_id === userId;
  if (row.scope === 'relation') return row.subject_id === userId || row.object_id === userId;
  return false;
}

async function onForget(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getInteger('id', true);
  const row = getMemory(id);
  if (!row || !isOwnMemory(row, interaction.user.id)) {
    await replyEphemeral(interaction, `没有找到关于你的记忆 #${id}（可以用 /memory 查看编号）。`);
    return;
  }
  // 被它取代过的旧版本也一起删掉，避免"以前的信息"残留
  const n = deleteMemoryChain(id);
  await replyEphemeral(interaction, `已删除 #${id}：${row.content.slice(0, 80)}${n > 1 ? `（连同 ${n - 1} 条旧版本）` : ''}`);
}

async function onCallMe(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  upsertUser(userInfoFromDiscord(interaction.user), Date.now());
  const name = (interaction.options.getString('称呼') ?? '').trim();
  if (!name) {
    const cur = activeSlot('user', userId, 'preferred_name');
    if (cur) deleteMemory(cur.id);
    const addr = addressOf(userId, interaction.guildId, { includeSensitive: true });
    await replyEphemeral(interaction, `已清除自定义称呼，之后我会叫你「${addr.address}」。`);
    return;
  }
  if (name.length > 32 || forbiddenReason(name)) {
    await replyEphemeral(interaction, '这个称呼不太合适（太长或包含隐私信息），换一个吧。');
    return;
  }
  addMemory({
    scope: 'user',
    subjectId: userId,
    guildId: interaction.guildId,
    kind: 'fact',
    slot: 'preferred_name',
    value: name,
    content: `希望被称呼为「${name}」`,
    importance: 7,
    pinned: false,
    // 称呼里带着敏感话题时标为敏感：只在和本人聊天时使用，别人看到的档案里不出现
    sensitive: looksSensitive(name),
    origin: 'user',
    sourceUserId: userId,
  });
  await replyEphemeral(interaction, `好，以后叫你「${name}」。`);
}

async function onPronouns(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  upsertUser(userInfoFromDiscord(interaction.user), Date.now());
  const value = (interaction.options.getString('代词') ?? '').trim();
  const cur = activeSlot('user', userId, 'pronouns');
  if (!value) {
    await replyEphemeral(
      interaction,
      cur
        ? `你当前的代词是「${cur.value ?? cur.content}」。用 \`/pronouns 代词:清除\` 可以清除。`
        : '你还没有设置代词。用 `/pronouns 代词:她`（或 他、TA、they/them）来设置。'
    );
    return;
  }
  if (value === '清除') {
    if (cur) deleteMemory(cur.id);
    await replyEphemeral(interaction, '已清除你的代词设置。');
    return;
  }
  if (value.length > 20 || forbiddenReason(value)) {
    await replyEphemeral(interaction, '这个代词不太合适（太长或包含隐私信息），换一个吧。');
    return;
  }
  addMemory({
    scope: 'user',
    subjectId: userId,
    guildId: interaction.guildId,
    kind: 'fact',
    slot: 'pronouns',
    value,
    content: `希望别人用「${value}」来指代自己`,
    importance: 7,
    pinned: false,
    // 和 /callme 一样：取值里带着敏感话题时标为敏感，只在和本人聊天时使用
    sensitive: looksSensitive(value),
    origin: 'user',
    sourceUserId: userId,
  });
  await replyEphemeral(interaction, `好，提到你时会用「${value}」。`);
}

defineAiCommand({ name: 'memory', description: '查看 bot 记得的关于你的所有事（只有你能看到）' }, onMemory);

defineAiCommand(
  {
    name: 'forget',
    description: '删除一条关于你的记忆（编号见 /memory）',
    options: [{ name: 'id', description: '记忆编号', type: 4, required: true, min_value: 1 }],
  },
  onForget
);

defineAiCommand(
  {
    name: 'callme',
    description: '设定你希望 bot 怎么称呼你（留空 = 清除）',
    options: [{ name: '称呼', description: '希望被叫的名字', type: 3, required: false, max_length: 32 }],
  },
  onCallMe
);

defineAiCommand(
  {
    name: 'pronouns',
    description: '设置或查看你的代词，bot 提到你时会用它（填"清除"可清除）',
    options: [{ name: '代词', description: '如 她、他、TA、they/them；留空 = 查看当前', type: 3, required: false, max_length: 20 }],
  },
  onPronouns
);
