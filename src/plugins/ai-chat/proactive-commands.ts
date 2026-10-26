import { PermissionFlagsBits } from 'discord.js';
import { upsertChannel } from './channels';
import { defineAiCommand, replyEphemeral } from './command-registry';
import { setQuiet } from './proactive';
import { formatUtc8 } from './time';

defineAiCommand(
  {
    name: 'shh',
    description: '让 bot 暂时不要主动插话（被 @ 时照常回复）',
    default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
    options: [
      { name: '分钟', description: '暂停多久（0 = 立即恢复），默认 60', type: 4, required: false, min_value: 0, max_value: 1440 },
      {
        name: '范围',
        description: '只在本频道，还是整个服务器',
        type: 3,
        required: false,
        choices: [
          { name: '本频道', value: 'channel' },
          { name: '整个服务器', value: 'guild' },
        ],
      },
    ],
  },
  async (interaction) => {
    if (!interaction.guildId || !interaction.channelId) {
      await replyEphemeral(interaction, '只能在服务器里使用。');
      return;
    }
    const minutes = interaction.options.getInteger('分钟') ?? 60;
    const scope = interaction.options.getString('范围') === 'guild' ? 'guild' : 'channel';
    const now = Date.now();
    const until = minutes > 0 ? now + minutes * 60_000 : 0;
    const channel = interaction.channel as { parentId?: string | null; name?: string } | null;
    const ref = { channelId: interaction.channelId, guildId: interaction.guildId, parentId: channel?.parentId ?? null };
    upsertChannel({ channelId: ref.channelId, guildId: ref.guildId, parentId: ref.parentId, name: channel?.name ?? null, type: 'text' }, now);
    setQuiet(scope, ref, until);
    const where = scope === 'guild' ? '整个服务器' : '本频道';
    await replyEphemeral(
      interaction,
      until ? `好，${where}里我先不主动插话，直到 ${formatUtc8(until).slice(5, 16)}（UTC+8）。被 @ 时照常回复。` : `${where}的主动插话已恢复。`
    );
  }
);
