import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { defineAiCommand, replyEphemeral } from './command-registry';
import { userInfoFromDiscord } from './discord-adapter';
import { forgetUser } from './forget';
import { bindLegacyIdentity, isOptedOut, setOptOut, upsertUser } from './identity';
import { forgetPresence } from './presence';
// 各功能模块的命令在这里统一引入（模块加载时向 command-registry 注册）
import '@/plugins/ai-chat/memory/commands';
import './affinity-commands';
import './proactive-commands';

export { aiCommandDefinitions, handleAiCommand } from './command-registry';

defineAiCommand(
  { name: 'optout', description: '停止记录你的消息、不再形成关于你的记忆（被 @ 时仍会回复）' },
  async (interaction) => {
    upsertUser(userInfoFromDiscord(interaction.user), Date.now());
    if (isOptedOut(interaction.user.id)) {
      await replyEphemeral(interaction, '你已经处于退出状态，我不会记录你的消息。需要恢复时用 /optin。');
      return;
    }
    setOptOut(interaction.user.id, true);
    // 当前在线状态和还没结束的活动也一并丢掉
    forgetPresence(interaction.user.id);
    await replyEphemeral(
      interaction,
      '已退出：从现在起我不会再记录你的消息、也不会形成新的记忆。已有的数据还在，如需全部删除请用 /forget-me。恢复用 /optin。'
    );
  }
);

defineAiCommand({ name: 'optin', description: '恢复记录你的消息与形成记忆' }, async (interaction) => {
  upsertUser(userInfoFromDiscord(interaction.user), Date.now());
  if (!isOptedOut(interaction.user.id)) {
    await replyEphemeral(interaction, '你没有退出过，一切照常。');
    return;
  }
  setOptOut(interaction.user.id, false);
  await replyEphemeral(interaction, '已恢复：我会重新开始记住你说的话。');
});

defineAiCommand(
  { name: 'forget-me', description: '删除我的全部数据：消息记录、记忆、好感度、统计等（需要再点一次确认）', dm_permission: true },
  async (interaction) => {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('forget-me:all').setLabel('全部删除').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('forget-me:optout').setLabel('全部删除，并且以后不再记录').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('forget-me:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary)
    );
    const prompt = await interaction.reply({
      content: [
        '确定要删除我关于你的**全部数据**吗？这一步**无法撤销**。会删除：',
        '- 你的所有消息记录，以及我对这些消息的回复；',
        '- 关于你的全部记忆、你和别人的关系、我对你的印象和好感度、各种统计和画像；',
        '- 提到你名字的群记忆和我自己的记忆；别人消息里对你的 @ 会改成"@已删除的用户"。',
        '',
        'Discord 上已经发出的消息不受影响。选"全部删除"之后，你再发消息我还会重新开始记录；不想被记录请选第二个按钮。',
      ].join('\n'),
      components: [row],
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });
    const message = prompt.resource?.message;
    if (!message) return;
    const click = await message
      .awaitMessageComponent({ componentType: ComponentType.Button, filter: (i) => i.user.id === interaction.user.id, time: 60_000 })
      .catch(() => null);
    if (!click || click.customId === 'forget-me:cancel') {
      await interaction.editReply({ content: click ? '已取消，什么都没删。' : '超过 60 秒没有确认，已取消。', components: [] });
      if (click) await click.deferUpdate().catch(() => undefined);
      return;
    }
    await click.update({ content: '正在删除……', components: [] });
    try {
      const keepOptOut = click.customId === 'forget-me:optout';
      // 升级前的旧数据只按用户名记录：先用交互里可信的用户资料把旧身份认领过来，再算删除范围
      // （否则从没在群里说过话的老用户，旧记忆和旧对话会漏删）
      upsertUser(userInfoFromDiscord(interaction.user), Date.now());
      try {
        bindLegacyIdentity(interaction.user.id, interaction.user.username);
      } catch (e) {
        console.warn('[Forget] 认领旧身份失败（按已知身份继续删除）:', (e as Error).message);
      }
      const r = forgetUser(interaction.user.id, { keepOptOut });
      await interaction.editReply({
        content: [
          '已删除。',
          `- 消息记录 ${r.messages} 条（以及我的回复 ${r.botReplies} 条），记忆 ${r.memories} 条，其它记录 ${r.rows} 条；`,
          `- 匿名化了别人消息里对你的 @ ${r.scrubbedMessages} 处。`,
          keepOptOut ? '以后我不会再记录你的消息（被 @ 时仍会回复）。改主意了可以用 /optin。' : '你再发消息，我会重新开始认识你。',
        ].join('\n'),
      });
    } catch (e) {
      console.error('[Forget] 删除失败:', e);
      await interaction.editReply({ content: '删除时出错了，数据没有改动（整个删除在一个事务里）。请稍后再试，或者联系管理员。' });
    }
  }
);
