import { type Client, type GuildTextBasedChannel, type Message, type TextChannel } from 'discord.js';
import { getDiscordClient, getPrivilegedIntents } from '@/bots/discord';
import { logger } from '@/logger';
import { executeDiscordMessageHook } from '@/plugins';
import { queueAppraisal } from './appraise';
import { markBotMessage } from './channels';
import { chatWithAI, isAiEnabled } from './chat';
import { getAiConfig } from './config';
import { activePersona } from './context';
import { imageUrlsFromDiscord, isSelfRole, personFromDiscord, renderMessage } from './discord-adapter';
import { beginDirectReply, endDirectReply, onAddressedMessage, onUnaddressedMessage, registerProactive } from './discord-proactive';
import { attachIngestHandlers, backfillForTool, channelQuoteGuard, ingestLiveMessage, refreshPersonFromDiscord } from './discord-runtime';
import { sendAiText, startTyping } from './discord-send';
import { forgetEpoch, forgottenAt, forgottenBefore, isForgottenMessage, recordForgottenMessage } from './forget-guard';
import { personFromDb } from './identity';
import { ingestDelete, isGuildAllowed, withoutForgottenRendered } from './ingest';
import { mentionedPeople, sanitizeOutgoingMentions, type PersonRef } from './mentions';
import { formatUtc8 } from './time';

// 当前挂着消息处理的 Discord 客户端（核心 bots/discord.ts 创建；测试里是假的客户端）
let client: Client | null = null;

/**
 * 给 Discord 客户端挂上 AI 聊天：消息 / 编辑 / 删除 / 表情 / 成员 / 在线状态的入库与历史补全、直接回复、主动插话。
 * 由插件在 onAfterInit 里调用；客户端默认取核心创建的那个。
 */
export function initDiscordAiChat(c: Client | null = getDiscordClient()): boolean {
  client = c;
  if (!client || !isAiEnabled()) {
    if (client && !isAiEnabled()) {
      logger.info('AI', 'AI 聊天未启用，跳过 Discord AI 消息监听');
    }
    return false;
  }

  // 消息编辑/删除/表情反应/成员/在线状态的入库，以及启动和重连后的历史补全
  attachIngestHandlers(client, getPrivilegedIntents());
  // 主动插话：反馈统计与定期结算
  registerProactive();

  client.on('messageCreate', (message: Message) => {
    // 这是消息路径上最热的一段(每条消息都跑)：任何异常只记录，绝不能逃逸成未处理拒绝
    onMessageCreate(message).catch((e) => logger.error('AI', '处理消息异常(已忽略):', (e as Error)?.message || e));
  });

  logger.info('AI', 'Discord AI 聊天监听器已注册');
  return true;
}

/** 这条消息是在叫 bot：直接 @ bot、回复 bot 的消息、或 @ 了 bot 的托管角色。@everyone / @here 默认不算（ignoreEveryoneMention）。 */
function isAddressedToBot(message: Message, selfId: string): boolean {
  const ignoreEveryone = getAiConfig().ignoreEveryoneMention;
  if (message.mentions.has(selfId, { ignoreEveryone, ignoreRoles: true, ignoreRepliedUser: true })) return true;
  if (message.mentions.repliedUser?.id === selfId) return true;
  return message.mentions.roles.some((r) => isSelfRole(message.guild, r.id, selfId));
}

async function onMessageCreate(message: Message): Promise<void> {
  if (!client?.user) return;
  const selfId = client.user.id;

  const addressed = !message.author.bot && isAddressedToBot(message, selfId);
  // 每条消息（包括 bot 自己发出的）都先入库；关掉被动观察时只记叫到 bot 的消息。入库失败只告警，不影响后续回复
  ingestLiveMessage(message, selfId, { addressed });

  if (message.author.bot) return;
  // 其它插件的文本命令（如 jm-daily 的 /jm）：被认领了就不再当成聊天处理
  if (await executeDiscordMessageHook(message).catch(() => false)) return;
  if (!addressed) {
    // 不是在叫 bot：交给主动插话（防抖后评估要不要自己插一句）
    if (isGuildAllowed(message.guildId)) onUnaddressedMessage(message, selfId);
    return;
  }

  if (!isGuildAllowed(message.guildId)) {
    logger.info('AI', `服务器 ${message.guildId || 'DM'} 不在 AI 允许列表中，跳过`);
    return;
  }
  // 有人直接叫 bot：如果刚刚主动插过话，这算是被接住了
  onAddressedMessage(message);
  // 正在直接回复（从读引用消息到发送、入库、更新冷却）：这个频道排着的主动插话先别插，免得对同一条消息再答一遍
  beginDirectReply(message.channelId);
  try {
    await replyDirectly(message, selfId);
  } finally {
    endDirectReply(message.channelId);
  }
}

/**
 * 被引用的消息能不能带进上下文（和入库的规则一致）：不是 TA /forget-me 之前写的；
 * 也不是当时连带删除的 bot 消息（消息墓碑），或 bot 回复删除前的 TA 的消息。
 */
function referenceAllowed(ref: Message): boolean {
  if (forgottenBefore(ref.author.id, ref.createdTimestamp) || isForgottenMessage(ref.id)) return false;
  const repliedTo = ref.author.bot ? ref.mentions.repliedUser?.id : undefined;
  return !(repliedTo && forgottenBefore(repliedTo, ref.createdTimestamp));
}

/** 被引用（回复）的那条消息 */
async function fetchReferenced(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId) {
    if (message.reference) logger.warn('AI', `检测到 message.reference 但无 messageId:`, JSON.stringify(message.reference));
    return null;
  }
  try {
    return message.channel.isTextBased() ? await message.channel.messages.fetch(message.reference.messageId) : null;
  } catch (e) {
    logger.error('AI', `获取引用消息失败 (messageId=${message.reference.messageId}):`, (e as Error).message);
    return null;
  }
}

/** 发出的回复因为期间发生了删除而不该入库：记消息墓碑，并删掉 Discord 回传后可能已经先入库的同一条 */
function discardSent(sent: Message[]): void {
  for (const m of sent) {
    recordForgottenMessage(m.id, Date.now());
    ingestDelete(m.id);
  }
}

async function replyDirectly(message: Message, selfId: string): Promise<void> {
  // 正文里的 <@id> 等标记渲染成 @显示名（去掉对 bot 自己的 @），模型才知道提到的是谁
  const rendered = renderMessage(message, selfId, true);
  const content = rendered.text;
  const ownImages = imageUrlsFromDiscord(message);
  const bareMention = !content && ownImages.length === 0 && !message.reference?.messageId;

  if (bareMention && !getAiConfig().summary?.enabled) {
    try {
      await message.reply('你好！请 @我 然后输入你的问题，我会尽力回答。');
    } catch (e) {
      // ignore
    }
    return;
  }

  const refMsg = await fetchReferenced(message);
  const startedAt = Date.now();
  /**
   * 本轮的上下文：被 @ 的人 + 被回复消息的作者（都不含 bot 自己）、被引用的消息、图片。
   * 每次生成前重新组装：期间执行了 /forget-me 的人不再出现，TA 删除之前写的那条被引用消息（原文、身份、图片）也不带。
   */
  const buildInputs = (): { people: Map<string, PersonRef>; contextMessage: string | undefined; imageUrls: string[] } => {
    const people = new Map<string, PersonRef>();
    for (const p of mentionedPeople(rendered)) {
      if (!p.isSelf && p.id !== message.author.id && (forgottenAt(p.id) ?? 0) < startedAt) people.set(p.id, p);
    }
    let contextMessage: string | undefined;
    let imageUrls = ownImages;
    if (refMsg && referenceAllowed(refMsg)) {
      const refAuthor = refMsg.member?.displayName || refMsg.author.username;
      const refContent = withoutForgottenRendered(renderMessage(refMsg, selfId), refMsg.createdTimestamp).text.slice(0, 2000);
      contextMessage = `[${formatUtc8(refMsg.createdTimestamp)}] [${refAuthor}]: ${refContent}`;
      if (refMsg.author.id !== selfId && refMsg.author.id !== message.author.id) {
        people.set(refMsg.author.id, personFromDiscord(refMsg.author, refMsg.member, selfId));
      }
      const refImgs = imageUrlsFromDiscord(refMsg);
      if (refImgs.length) imageUrls = [...imageUrls, ...refImgs].slice(0, 6);
    }
    return { people, contextMessage, imageUrls };
  };

  const displayName = message.member?.displayName || message.author.username;
  const summaryEnabled = !!getAiConfig().summary?.enabled;
  const channel = message.channel;
  const stopTyping = channel.isTextBased() ? startTyping(channel as TextChannel) : () => {};

  let reply = '';
  let reactions: string[] = [];
  let inputs = buildInputs();
  if (inputs.contextMessage) {
    logger.info('AI', `带上下文回复 ${message.author.username} (引用: ${inputs.contextMessage.slice(0, 40)}...)`);
  }
  const mentionable = new Set<string>();
  // 回复对应的删除代次：之后（贴表情、发送期间）有人删除了数据，就不能再把这次的结果当成删除后的数据入库
  let genEpoch = forgetEpoch();
  try {
    for (let attempt = 0; ; attempt++) {
      genEpoch = forgetEpoch();
      const res = await chatWithAI(content, {
        username: message.author.username,
        userId: message.author.id,
        displayName,
        speaker: personFromDiscord(message.author, message.member, selfId),
        people: [...inputs.people.values()],
        contextMessage: inputs.contextMessage,
        platform: 'discord',
        guildId: message.guildId ?? undefined,
        channelId: message.channelId,
        messageId: message.id,
        images: inputs.imageUrls.length ? inputs.imageUrls : undefined,
        bareMention,
        backfillChannel:
          (summaryEnabled || getAiConfig().memory.enabled) && channel.isTextBased() && message.guild
            ? (target: number) => backfillForTool(channel as GuildTextBasedChannel, selfId, target).then(() => undefined)
            : undefined,
        refreshPerson: (uid: string) => refreshPersonFromDiscord(message.guild, uid),
        canQuoteChannel: channelQuoteGuard(message.client, message.author.id),
      });
      reply = res.reply;
      reactions = res.reactions;
      mentionable.clear();
      for (const id of [message.author.id, ...inputs.people.keys(), ...(res.mentionableIds ?? [])]) mentionable.add(id);
      // 生成期间有人 /forget-me 或删除了记忆：模型手里的上下文可能带着被删的内容，用删除后的数据重新生成一次
      if (forgetEpoch() === genEpoch || attempt >= 1) break;
      logger.info('AI', '生成期间有数据被删除，按删除后的数据重新生成');
      inputs = buildInputs();
    }
  } catch (e) {
    // chatWithAI 正常不会抛(内部已兜底)，但万一抛出也要给用户一条兜底消息，绝不静默装死
    logger.error('AI', 'chatWithAI 异常(兜底):', (e as Error).message);
    reply = 'AI 暂时不可用，请稍后再试。';
  } finally {
    stopTyping();
  }

  for (const emoji of reactions) {
    try {
      await message.react(emoji);
    } catch (e) {
      logger.warn('AI', `贴表情失败 (${emoji}):`, (e as Error).message);
    }
  }

  // 发送前按当前状态重算提醒白名单：这期间删除了自己数据的人不再提醒
  for (const id of [...mentionable]) if ((forgottenAt(id) ?? 0) >= startedAt) mentionable.delete(id);
  // 回复里的 @ 只保留本轮上下文出现过的人，其余改成纯文本；@everyone/@here/角色一律不提醒
  const { text, userIds } = sanitizeOutgoingMentions(
    reply,
    mentionable,
    (id) => personFromDb(id, message.guildId, selfId)?.displayName ?? null
  );
  const sent = await sendAiText(message, text, userIds);
  // bot 说过话了（不管入不入库）：主动插话的冷却从现在算
  if (sent.length > 0) markBotMessage(message.channelId, Date.now());
  if (forgetEpoch() !== genEpoch) {
    // 生成之后（贴表情、发送期间）又有人删除了数据：这次的回复不入库，也不做互动评估
    discardSent(sent);
  } else {
    for (const m of sent) ingestLiveMessage(m, selfId, { kind: 'bot_ai' });
    if (sent.length > 0) {
      try {
        // 异步评估这次互动：好感、印象、心情、自我记忆（不增加回复延迟）
        queueAppraisal({
          userId: message.author.id,
          guildId: message.guildId,
          channelId: message.channelId,
          userMessageId: message.id,
          botMessageIds: sent.map((m) => m.id),
          personaId: activePersona(message.guildId)?.id ?? null,
        });
      } catch (e) {
        logger.warn('AI', '投递互动评估失败(忽略):', (e as Error).message);
      }
    }
  }
  logger.info('AI', `回复 ${message.author.username}: ${text.slice(0, 60).replace(/\s+/g, ' ')}...`);
}

