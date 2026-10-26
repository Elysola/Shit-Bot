import { Client, TextChannel, EmbedBuilder, AttachmentBuilder, Message, REST, Routes, ChatInputCommandInteraction, MessageFlags, Partials, type GuildTextBasedChannel } from 'discord.js';
import { ProcessedTweet } from '../types';
import { getConfig } from '../config';
import { formatContentForPlatform } from '../filters';
import { renderTweetImage } from '../renderer';
import { storeSentMessage, getRecentSentMessages, deleteSentMessage, getSentMessageByMessageId } from '../storage';
import { chatWithAI, isAiEnabled } from '../ai/chat';
import { formatUtc8 } from '../ai/time';
import { aiCommandDefinitions } from '../ai/commands';
import { markBotMessage } from '../ai/channels';
import { imageUrlsFromDiscord, isSelfRole, personFromDiscord, renderMessage } from '../ai/discord-adapter';
import { attachIngestHandlers, backfillForTool, channelQuoteGuard, ingestLiveMessage, refreshPersonFromDiscord } from '../ai/discord-runtime';
import { personFromDb } from '../ai/identity';
import { ingestDelete, isGuildAllowed, withoutForgottenRendered } from '../ai/ingest';
import { buildIntents, decidePrivilegedIntents, isDisallowedIntentsError, type PrivilegedIntents } from '../ai/intents';
import { mentionedPeople, sanitizeOutgoingMentions, type PersonRef } from '../ai/mentions';
import { flushPresenceSessions } from '../ai/presence';
import { queueAppraisal } from '../ai/appraise';
import { activePersona } from '../ai/context';
import { sendAiText, startTyping } from './discord-send';
import { beginDirectReply, endDirectReply, onAddressedMessage, onUnaddressedMessage, registerProactive } from './discord-proactive';
import { forgetEpoch, forgottenAt, forgottenBefore, isForgottenMessage, recordForgottenMessage } from '../ai/forget-guard';

let client: Client | null = null;
let targetChannel: TextChannel | null = null;
let privileged: PrivilegedIntents = { members: false, presences: false };

export function getPrivilegedIntents(): PrivilegedIntents {
  return privileged;
}

function createClient(p: PrivilegedIntents): Client {
  return new Client({
    intents: buildIntents(p),
    // 编辑/删除/表情反应可能发生在未缓存的消息上，需要 partial 才能收到事件
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
  });
}

function callWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时')), timeoutMs);
    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function getDiscordClient(): Client | null {
  return client;
}

/** 测试用：换成一个假的客户端（不登录 Discord），之后照常调用 initDiscordAiChat() 挂上消息处理 */
export function useDiscordClientForTesting(c: Client | null, p: PrivilegedIntents = { members: false, presences: false }): void {
  client = c;
  privileged = p;
  targetChannel = null;
}

export async function initDiscord(): Promise<boolean> {
  const config = getConfig();

  if (!config.discord.enabled) {
    console.log('Discord 已在配置中禁用');
    return false;
  }

  // 特权 intent 自适配：登录前读应用标志位，后台开了什么就订阅什么
  const decision = await decidePrivilegedIntents(config.discord.token, config.discord.privilegedIntents);
  privileged = { members: decision.members, presences: decision.presences };

  try {
    client = createClient(privileged);
    await client.login(config.discord.token);
  } catch (error) {
    if ((privileged.members || privileged.presences) && isDisallowedIntentsError(error)) {
      // 配置强制开启、或标志位与实际不符：去掉特权 intent 再试一次，保证 bot 能上线
      console.warn('[Intents] 申请的特权 intent 未在开发者后台开启，去掉后重新登录');
      await client?.destroy().catch(() => {});
      privileged = { members: false, presences: false };
      try {
        client = createClient(privileged);
        await client.login(config.discord.token);
      } catch (retryError) {
        console.error('Discord 初始化失败:', retryError);
        client = null;
        targetChannel = null;
        return false;
      }
    } else {
      console.error('Discord 初始化失败:', error);
      client = null;
      targetChannel = null;
      return false;
    }
  }

  console.log(
    `Discord bot 已连接 (群组指定目标频道)；特权 intent：成员事件=${privileged.members ? '开' : '关'}，在线状态=${privileged.presences ? '开' : '关'}`
  );
  return true;
}

export async function sendToDiscord(tweet: ProcessedTweet, channelId?: string, asImage?: boolean, preRenderedImage?: Buffer, approvalId?: string): Promise<Message | null> {
  const config = getConfig();
  const sendImage = asImage ?? config.sendAsImage;

  if (!client) {
    console.error('Discord 未初始化');
    return null;
  }

  let sendTo: TextChannel | null = null;

  if (channelId) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        sendTo = channel as TextChannel;
      }
    } catch (e) {
      console.error(`获取 Discord 频道 ${channelId} 失败:`, e);
    }
  }

  if (!sendTo) {
    console.error(`Discord 频道不可用${channelId ? ` (${channelId})` : ""}`);
    return null;
  }

  try {
    let sentMessage: Message | null;

    if (sendImage) {
      const imageBuffer = preRenderedImage || await renderTweetImage(tweet);
      if (imageBuffer) {
        const buf = Buffer.from(imageBuffer);
        const attachment = new AttachmentBuilder(buf, { name: `tweet_${tweet.id}.png` });
        const embed = new EmbedBuilder()
          .setAuthor({ name: `@${tweet.author}`, url: `https://x.com/${tweet.author}` })
          .setDescription(`[🔗 在 X 上查看](${tweet.url})`)
          .setURL(tweet.url)
          .setImage(`attachment://tweet_${tweet.id}.png`)
          .setColor((config.discord.embedColor || '#1DA1F2') as `#${string}`)
          .setTimestamp(tweet.publishedAt);

        if (approvalId) {
          embed.setFooter({ text: `🆔 ${approvalId}` });
        }

        sentMessage = await sendWithRetry(sendTo, { embeds: [embed], files: [attachment] }, tweet.id);
        if (sentMessage) {
          storeSentMessage(sendTo.id, sentMessage.id, tweet.id);
          console.log(`[Discord] 以图片形式发送推文 ${tweet.id}${channelId ? ` (${channelId})` : ""}`);
          return sentMessage;
        }
      }
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: `@${tweet.author}`, url: `https://x.com/${tweet.author}`, iconURL: `https://unavatar.io/twitter/${tweet.author}` })
      .setDescription(formatContentForPlatform(tweet.content, 'discord'))
      .setURL(tweet.url)
      .setTimestamp(tweet.publishedAt)
      .setColor((config.discord.embedColor || '#1DA1F2') as `#${string}`);

    if (tweet.mediaUrls.length > 0 && tweet.mediaUrls[0]) {
      embed.setImage(tweet.mediaUrls[0]);
    }

    const footerParts: string[] = [];
    if (approvalId) footerParts.push(`🆔 ${approvalId}`);
    if (tweet.mediaUrls.length > 0) footerParts.push(`${tweet.mediaUrls.length} 个媒体附件`);
    if (footerParts.length > 0) {
      embed.setFooter({ text: footerParts.join(' | ') });
    }

    sentMessage = await sendWithRetry(sendTo, { embeds: [embed] }, tweet.id);
    if (sentMessage) {
      storeSentMessage(sendTo.id, sentMessage.id, tweet.id);
      console.log(`[Discord] 发送推文 ${tweet.id}${channelId ? ` (${channelId})` : ""}`);
      return sentMessage;
    }

    console.error(`[Discord] 推文 ${tweet.id} 发送失败, 所有重试均未成功`);
    return null;
  } catch (error) {
    console.error(`[Discord] 发送推文 ${tweet.id} 失败:`, error);
    return null;
  }
}

async function sendWithRetry(channel: TextChannel, payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }, tweetId: string): Promise<Message | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await callWithTimeout(() => channel.send(payload), 15000);
      return msg;
    } catch (error) {
      console.error(`[Discord] 发送尝试 ${attempt}/3 失败, 推文 ${tweetId}:`, (error as Error).message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
      }
    }
  }
  return null;
}

export async function sendBatchToDiscord(tweets: ProcessedTweet[]): Promise<number> {
  let sent = 0;

  for (const tweet of tweets) {
    const msg = await sendToDiscord(tweet);
    if (msg) {
      sent++;
    }
    
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return sent;
}

export async function recallMessages(channelId: string, count: number): Promise<number> {
  if (!client) return 0;

  const records = getRecentSentMessages(channelId, count);
  let deleted = 0;

  for (const record of records) {
    try {
      const channel = await client.channels.fetch(record.channel_id);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(record.message_id);
        await message.delete();
        deleteSentMessage(record.message_id);
        deleted++;
      }
    } catch (error) {
      deleteSentMessage(record.message_id);
    }
  }

  return deleted;
}

export async function recallMessageById(messageId: string): Promise<boolean> {
  if (!client) return false;

  const record = getSentMessageByMessageId(messageId);

  if (record) {
    try {
      const channel = await client.channels.fetch(record.channel_id);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(messageId);
        await message.delete();
        deleteSentMessage(messageId);
        return true;
      }
    } catch {}
    deleteSentMessage(messageId);
    return false;
  }

  for (const [, channel] of client.channels.cache) {
    if (!channel.isTextBased()) continue;
    try {
      const message = await (channel as TextChannel).messages.fetch(messageId);
      if (message.author.id === client.user?.id) {
        await message.delete();
        return true;
      }
    } catch {}
  }

  return false;
}

export async function registerDiscordCommands(): Promise<void> {
  if (!client) return;

  try {
    const rest = new REST({ version: '10' }).setToken(getConfig().discord.token);

    const commands = [
      {
        name: 'recall',
        description: '撤回 bot 发送的消息 (需要审批权限)',
        options: [
          {
            name: 'count',
            description: '撤回最近 N 条消息 (默认 5)',
            type: 4,
            required: false,
          },
          {
            name: 'message_id',
            description: '指定要撤回的消息 ID',
            type: 3,
            required: false,
          },
          {
            name: 'link',
            description: '指定要撤回的消息链接',
            type: 3,
            required: false,
          },
        ],
      },
      {
        name: '撤回消息',
        type: 3,
      },
      // /memory /forget /callme /optout /optin 等 AI 命令（旧的 /delete-memory 已由 /forget 取代）
      ...(isAiEnabled() ? aiCommandDefinitions() : []),
    ];

    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: commands }
    );

    console.log('Discord 斜杠命令已注册');
  } catch (error) {
    console.error('Discord 命令注册失败:', error);
  }
}

export async function shutdownDiscord(): Promise<void> {
  try {
    flushPresenceSessions();
  } catch {
    // 退出途中数据库可能已不可用，忽略
  }
  if (client) {
    await client.destroy();
    client = null;
    targetChannel = null;
    console.log('Discord bot 已断开');
  }
}


export function initDiscordAiChat(): boolean {
  if (!client || !isAiEnabled()) {
    if (client && !isAiEnabled()) {
      console.log('AI 聊天未启用，跳过 Discord AI 消息监听');
    }
    return false;
  }

  // 消息编辑/删除/表情反应/成员/在线状态的入库，以及启动和重连后的历史补全
  attachIngestHandlers(client, privileged);
  // 主动插话：反馈统计与定期结算
  registerProactive();

  client.on('messageCreate', (message: Message) => {
    // 这是消息路径上最热的一段(每条消息都跑)：任何异常只记录，绝不能逃逸成未处理拒绝
    onMessageCreate(message).catch((e) => console.error('[AI] 处理消息异常(已忽略):', (e as Error)?.message || e));
  });

  console.log('Discord AI 聊天监听器已注册');
  return true;
}

/** 这条消息是在叫 bot：直接 @ bot、回复 bot 的消息、或 @ 了 bot 的托管角色。@everyone / @here 不算。 */
function isAddressedToBot(message: Message, selfId: string): boolean {
  if (message.mentions.has(selfId, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) return true;
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
  if (!addressed) {
    // 不是在叫 bot：交给主动插话（防抖后评估要不要自己插一句）
    if (isGuildAllowed(message.guildId)) onUnaddressedMessage(message, selfId);
    return;
  }

  if (!isGuildAllowed(message.guildId)) {
    console.log(`[AI] 服务器 ${message.guildId || 'DM'} 不在 AI 允许列表中，跳过`);
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
    if (message.reference) console.warn(`[AI] 检测到 message.reference 但无 messageId:`, JSON.stringify(message.reference));
    return null;
  }
  try {
    return message.channel.isTextBased() ? await message.channel.messages.fetch(message.reference.messageId) : null;
  } catch (e) {
    console.error(`[AI] 获取引用消息失败 (messageId=${message.reference.messageId}):`, (e as Error).message);
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

  if (bareMention && !getConfig().ai.summary?.enabled) {
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
  const summaryEnabled = !!getConfig().ai.summary?.enabled;
  const channel = message.channel;
  const stopTyping = channel.isTextBased() ? startTyping(channel as TextChannel) : () => {};

  let reply = '';
  let reactions: string[] = [];
  let inputs = buildInputs();
  if (inputs.contextMessage) {
    console.log(`[AI] 带上下文回复 ${message.author.username} (引用: ${inputs.contextMessage.slice(0, 40)}...)`);
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
          (summaryEnabled || getConfig().ai.memory.enabled) && channel.isTextBased() && message.guild
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
      console.log('[AI] 生成期间有数据被删除，按删除后的数据重新生成');
      inputs = buildInputs();
    }
  } catch (e) {
    // chatWithAI 正常不会抛(内部已兜底)，但万一抛出也要给用户一条兜底消息，绝不静默装死
    console.error('[AI] chatWithAI 异常(兜底):', (e as Error).message);
    reply = 'AI 暂时不可用，请稍后再试。';
  } finally {
    stopTyping();
  }

  for (const emoji of reactions) {
    try {
      await message.react(emoji);
    } catch (e) {
      console.warn(`[AI] 贴表情失败 (${emoji}):`, (e as Error).message);
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
        console.warn('[AI] 投递互动评估失败(忽略):', (e as Error).message);
      }
    }
  }
  console.log(`[AI] 回复 ${message.author.username}: ${text.slice(0, 60).replace(/\s+/g, ' ')}...`);
}

