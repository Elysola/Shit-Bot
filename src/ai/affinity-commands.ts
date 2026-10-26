import { describeRelationshipForUser } from './affinity';
import { defineAiCommand, replyEphemeral } from './command-registry';
import { personaForGuild } from './persona/loader';

defineAiCommand({ name: 'affinity', description: '看看 bot 现在对你是什么感觉（只有你能看到）' }, async (interaction) => {
  const name = personaForGuild(interaction.guildId)?.name ?? 'bot';
  const r = describeRelationshipForUser(interaction.user.id);
  const lines = [`${name} 对你的感觉：**${r.level}**`];
  if (r.impression) lines.push(`印象：${r.impression}`);
  if (r.petName) lines.push(`专属称呼：${r.petName}`);
  lines.push(r.interactions > 0 ? `你们直接聊过 ${r.interactions} 次。` : '你们还没有直接聊过。');
  await replyEphemeral(interaction, lines.join('\n'));
});
