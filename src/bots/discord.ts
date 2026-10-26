import { Client, TextChannel, EmbedBuilder, AttachmentBuilder, Message, REST, Routes, ChatInputCommandInteraction, MessageFlags, Partials } from 'discord.js';
import { ProcessedTweet } from '@/types';
import { getConfig } from '@/config';
import { formatContentForPlatform } from '@/filters';
import { renderTweetImage } from '@/renderer';
import { storeSentMessage, getRecentSentMessages, deleteSentMessage, getSentMessageByMessageId } from '@/storage';
import { getPluginDiscordCommands } from '@/plugins';
import { logger } from '@/logger';
import { buildIntents, decidePrivilegedIntents, isDisallowedIntentsError, type PrivilegedIntents } from '@/bots/discord-intents';


let client: Client | null = null;
let targetChannel: TextChannel | null = null;
let privileged: PrivilegedIntents = { members: false, presences: false };

/** 这次登录实际订阅到的特权 intent（插件据此决定要不要同步成员、读在线状态） */
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

async function login(c: Client, token: string): Promise<void> {
  await Promise.race([
    c.login(token),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Discord 登录超时 (30s)')), 30000)),
  ]);
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

/** 测试用：换成一个假的客户端（不登录 Discord），之后插件照常挂上消息处理 */
export function useDiscordClientForTesting(c: Client | null, p: PrivilegedIntents = { members: false, presences: false }): void {
  client = c;
  privileged = p;
  targetChannel = null;
}

export async function initDiscord(): Promise<boolean> {
  const config = getConfig();

  if (!config.discord.enabled) {
    logger.info("Discord", "Discord 已在配置中禁用");
    return false;
  }

  logger.info("Discord", "正在初始化 Discord 客户端...");

  // 特权 intent 自适配：登录前读应用标志位，后台开了什么就订阅什么
  const decision = await decidePrivilegedIntents(config.discord.token, config.discord.privilegedIntents);
  privileged = { members: decision.members, presences: decision.presences };

  try {
    client = createClient(privileged);
    await login(client, config.discord.token);
  } catch (error) {
    if ((privileged.members || privileged.presences) && isDisallowedIntentsError(error)) {
      // 配置强制开启、或标志位与实际不符：去掉特权 intent 再试一次，保证 bot 能上线
      logger.warn("Discord", "申请的特权 intent 未在开发者后台开启，去掉后重新登录");
      await client?.destroy().catch(() => {});
      privileged = { members: false, presences: false };
      try {
        client = createClient(privileged);
        await login(client, config.discord.token);
      } catch (retryError) {
        logger.error("Discord", "Discord 初始化失败:", retryError);
        client = null;
        targetChannel = null;
        return false;
      }
    } else {
      logger.error("Discord", "Discord 初始化失败:", error);
      client = null;
      targetChannel = null;
      return false;
    }
  }

  logger.info(
    "Discord",
    `Discord bot 已连接 (群组指定目标频道)；特权 intent：成员事件=${privileged.members ? '开' : '关'}，在线状态=${privileged.presences ? '开' : '关'}`
  );
  return true;
}

export async function sendToDiscord(tweet: ProcessedTweet, channelId?: string, asImage?: boolean, preRenderedImage?: Buffer, approvalId?: string): Promise<Message | null> {
  const config = getConfig();
  const sendImage = asImage ?? config.sendAsImage;

  if (!client) {
    logger.error("Discord", "Discord 未初始化");
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
      logger.error("Discord", `获取 Discord 频道 ${channelId} 失败:`, e);
    }
  }

  if (!sendTo) {
    logger.error("Discord", `Discord 频道不可用${channelId ? ` (${channelId})` : ""}`);
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
          .setTimestamp(new Date(tweet.publishedAt));

        if (approvalId) {
          embed.setFooter({ text: `🆔 ${approvalId}` });
        }

        sentMessage = await sendWithRetry(sendTo, { embeds: [embed], files: [attachment] }, tweet.id);
        if (sentMessage) {
          storeSentMessage(sendTo.id, sentMessage.id, tweet.id);
          logger.info("Discord", `以图片形式发送推文 ${tweet.id}${channelId ? ` (${channelId})` : ""}`);
          return sentMessage;
        }
      }
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: `@${tweet.author}`, url: `https://x.com/${tweet.author}`, iconURL: `https://unavatar.io/twitter/${tweet.author}` })
      .setDescription(formatContentForPlatform(tweet.content, 'discord'))
      .setURL(tweet.url)
      .setTimestamp(new Date(tweet.publishedAt))
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
      logger.info("Discord", `发送推文 ${tweet.id}${channelId ? ` (${channelId})` : ""}`);
      return sentMessage;
    }

    logger.error("Discord", `推文 ${tweet.id} 发送失败, 所有重试均未成功`);
    return null;
  } catch (error) {
    logger.error("Discord", `发送推文 ${tweet.id} 失败:`, error);
    return null;
  }
}

async function sendWithRetry(channel: TextChannel, payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }, tweetId: string): Promise<Message | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await callWithTimeout(() => channel.send(payload), 15000);
      return msg;
    } catch (error) {
      logger.error("Discord", `发送尝试 ${attempt}/3 失败, 推文 ${tweetId}:`, (error as Error).message);
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

    const coreCommands = [
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
    ];

    const pluginCommands = await getPluginDiscordCommands();
    const commands = [...coreCommands, ...pluginCommands];

    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: commands }
    );

    logger.info("Discord", `Discord 斜杠命令已注册 (${commands.length} 个)`);
  } catch (error) {
    logger.error("Discord", "Discord 命令注册失败:", error);
  }
}

export async function shutdownDiscord(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
    targetChannel = null;
    logger.info("Discord", "Discord bot 已断开");
  }
}
