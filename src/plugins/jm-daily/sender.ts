import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { isOneBotConnected, sendImageToOneBot, sendTextToOneBot } from "@/bots/onebot";
import type { JmAlbumSummary } from "./jm";
import { downloadCover, escapeHTML, formatAlbumText } from "./jm";
import type { PluginLogger } from "@/plugins/types";

export interface ResolvedTargets {
  telegram: string[];
  discord: string[];
  onebot: number[];
}

interface SenderDeps {
  getDiscordClient: () => any;
  getTelegramBot: () => any;
  logger: PluginLogger;
}

async function sendToTelegram(bot: any, chatId: string, content: string, image: Buffer | null): Promise<boolean> {
  try {
    if (image) {
      await bot.telegram.sendPhoto(
        chatId,
        { source: image },
        {
          caption: content.substring(0, 1024),
          parse_mode: "HTML",
        },
      );
    } else {
      await bot.telegram.sendMessage(chatId, content, { parse_mode: "HTML" });
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function sendToDiscord(
  client: any,
  channelId: string,
  album: JmAlbumSummary,
  text: string,
  image: Buffer | null,
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return false;

    const embed = new EmbedBuilder()
      .setTitle(album.name.substring(0, 256))
      .setURL(album.url)
      .setDescription(text)
      .setColor("#FF6B6B");

    let files: AttachmentBuilder[] | undefined;
    if (image) {
      const attachment = new AttachmentBuilder(image, { name: `jm_${album.id}.jpg` });
      embed.setImage(`attachment://jm_${album.id}.jpg`);
      files = [attachment];
    }
    await channel.send({ embeds: [embed], files });
    return true;
  } catch (err) {
    return false;
  }
}

async function sendToOneBot(groupId: number, text: string, image: Buffer | null): Promise<boolean> {
  try {
    const msgId = image
      ? await sendImageToOneBot(groupId, image.toString("base64"), text)
      : await sendTextToOneBot(text, groupId);
    return !!msgId;
  } catch (err) {
    return false;
  }
}

/**
 * 发送每日推荐到全部目标。
 * 返回成功发送（至少一个平台）的本子 id 列表。
 */
export async function sendDailyAlbums(
  albums: JmAlbumSummary[],
  header: string,
  targets: ResolvedTargets,
  sendImage: boolean,
  deps: SenderDeps,
): Promise<string[]> {
  const { getDiscordClient, getTelegramBot, logger } = deps;
  const discordClient = getDiscordClient();
  const telegramBot = getTelegramBot();
  const targetsEmpty = targets.telegram.length === 0 && targets.discord.length === 0 && targets.onebot.length === 0;
  if (targetsEmpty) {
    logger.warn("没有可用的发送目标（未配置 targets），跳过发送");
    return [];
  }

  const headerText = `${header}\n(${new Date().toLocaleString()})`;
  const headerHtml = escapeHTML(headerText);

  // 1. 发送标题头
  for (const chatId of targets.telegram) {
    try {
      await telegramBot?.telegram.sendMessage(chatId, headerHtml, { parse_mode: "HTML" });
    } catch (err) {
      logger.warn(`向 Telegram ${chatId} 发送标题失败: ${(err as Error)?.message}`);
    }
  }
  for (const channelId of targets.discord) {
    try {
      const channel = await discordClient?.channels.fetch(channelId);
      if (channel?.isTextBased()) await channel.send(headerText);
    } catch (err) {
      logger.warn(`向 Discord ${channelId} 发送标题失败: ${(err as Error)?.message}`);
    }
  }
  for (const groupId of targets.onebot) {
    if (!isOneBotConnected()) continue;
    try {
      await sendTextToOneBot(headerText, groupId);
    } catch (err) {
      logger.warn(`向 OneBot ${groupId} 发送标题失败: ${(err as Error)?.message}`);
    }
  }

  // 2. 逐本发送
  const sentIds: string[] = [];
  for (let i = 0; i < albums.length; i++) {
    const album = albums[i]!;
    const textPlain = formatAlbumText(album, i + 1, "plain");
    const textHtml = formatAlbumText(album, i + 1, "html");

    // 并发下载封面
    const image = sendImage ? await downloadCover(album.coverUrl) : null;

    const results: boolean[] = [];
    for (const chatId of targets.telegram) {
      results.push(await sendToTelegram(telegramBot, chatId, textHtml, image));
    }
    for (const channelId of targets.discord) {
      results.push(await sendToDiscord(discordClient, channelId, album, textPlain, image));
    }
    for (const groupId of targets.onebot) {
      results.push(isOneBotConnected() ? await sendToOneBot(groupId, textPlain, image) : false);
    }

    if (results.some(Boolean)) {
      sentIds.push(album.id);
      logger.info(`已发送: JM${album.id} ${album.name.slice(0, 30)}`);
    } else {
      logger.warn(`发送失败: JM${album.id} ${album.name.slice(0, 30)}`);
    }
  }

  return sentIds;
}
