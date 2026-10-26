import { Telegraf } from 'telegraf';
import { ProcessedTweet } from '@/types';
import { getConfig } from '@/config';
import { formatTweetHTML, escapeHTML } from '@/filters';
import { renderTweetImage } from '@/renderer';
import { storeSentTgMessage } from '@/storage';
import { logger } from '@/logger';

let bot: Telegraf | null = null;

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

export function getTelegramBot(): Telegraf | null {
  return bot;
}

function buildAgentOpts(): { httpsAgent?: any; fetch?: any } | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return undefined;

  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return { httpsAgent: new HttpsProxyAgent(proxy) };
  } catch {
    logger.warn("Telegram", "https-proxy-agent 未安装, 代理不会被使用");
    return undefined;
  }
}

export async function initTelegram(): Promise<boolean> {
  const config = getConfig();

  if (!config.telegram.enabled) {
    logger.info("Telegram", "Telegram 已在配置中禁用");
    return false;
  }

  try {
    const options: any = {};
    if (config.telegram.apiRoot) {
      options.telegram = { apiRoot: config.telegram.apiRoot };
    }

    const agentOpts = buildAgentOpts();
    if (agentOpts) {
      Object.assign(options.telegram || (options.telegram = {}), agentOpts);
    }

    bot = new Telegraf(config.telegram.token, options);

    bot.catch((err) => {
      logger.error("Telegram", "Telegram bot 错误:", err);
    });

    await bot.telegram.getMe();
    logger.info("Telegram", "Telegram bot 已连接");
    return true;
  } catch (error) {
    logger.error("Telegram", "Telegram 初始化失败:", error);
    bot = null;
    return false;
  }
}

export async function sendToTelegram(tweet: ProcessedTweet, targetChatId?: string, asImage?: boolean, preRenderedImage?: Buffer, approvalId?: string): Promise<boolean> {
  const config = getConfig();
  const sendImage = asImage ?? config.sendAsImage;
  const chatId = targetChatId;
  if (!chatId) {
    logger.error("Telegram", "未提供 Telegram 发送的 chat ID");
    return false;
  }

  if (!bot) {
    logger.error("Telegram", "Telegram 未初始化");
    return false;
  }

  const message = formatTweetHTML(tweet);

  if (sendImage) {
    const imageSent = await trySendImage(chatId, tweet, message, preRenderedImage, approvalId);
    if (imageSent) return true;
    logger.warn("Telegram", `图片发送失败, 推文 ${tweet.id}, 回退到文本模式`);
  }

  if (tweet.mediaUrls.length > 0 && tweet.mediaUrls[0]) {
    const mediaSent = await trySendMedia(chatId, tweet, tweet.mediaUrls[0], message, approvalId);
    if (mediaSent) return true;
  }

  const textSent = await trySendText(chatId, message, `tweet ${tweet.id}`, tweet.id, approvalId);
  if (textSent) return true;

  logger.error("Telegram", `推文 ${tweet.id} 发送失败, 所有方式均未成功`);
  return false;
}

async function trySendImage(chatId: string, tweet: ProcessedTweet, message: string, preRenderedImage?: Buffer, approvalId?: string): Promise<boolean> {
  if (!bot) return false;

  const imageBuffer = preRenderedImage || await renderTweetImage(tweet);
  if (!imageBuffer) return false;

  const idFooter = approvalId ? `\n\n<i>🆔 ${escapeHTML(approvalId)}</i>` : '';
  const caption = `<b>@${escapeHTML(tweet.author)}</b>\n<a href="${tweet.url}">🔗 在 X 上查看</a>${idFooter}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sent = await callWithTimeout(() => bot!.telegram.sendPhoto(
        chatId,
        { source: imageBuffer },
        { caption, parse_mode: 'HTML' }
      ));
      storeSentTgMessage(chatId, sent.message_id, tweet.id);
      logger.info("Telegram", `以图片形式发送推文 ${tweet.id} (${chatId})`);
      return true;
    } catch (error) {
      logger.error("Telegram", `图片发送尝试 ${attempt}/3 失败, 推文 ${tweet.id}:`, (error as Error).message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
      }
    }
  }
  return false;
}

async function trySendMedia(chatId: string, tweet: ProcessedTweet, mediaUrl: string, message: string, approvalId?: string): Promise<boolean> {
  if (!bot) return false;

  const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('video');
  const idFooter = approvalId ? `\n\n<i>🆔 ${escapeHTML(approvalId)}</i>` : '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const caption = (message + idFooter).substring(0, 1024);
      let sent: any;
      if (isVideo) {
        sent = await callWithTimeout(() => bot!.telegram.sendVideo(chatId, mediaUrl, {
          caption,
          parse_mode: 'HTML',
        }));
      } else {
        sent = await callWithTimeout(() => bot!.telegram.sendPhoto(chatId, mediaUrl, {
          caption,
          parse_mode: 'HTML',
        }));
      }
      storeSentTgMessage(chatId, sent.message_id, tweet.id);
      logger.info("Telegram", `以媒体形式发送推文 ${tweet.id} (${chatId})`);
      return true;
    } catch (error) {
      logger.error("Telegram", `媒体发送尝试 ${attempt}/3 失败, 推文 ${tweet.id}:`, (error as Error).message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
      }
    }
  }
  return false;
}

async function trySendText(chatId: string, message: string, label: string, tweetId?: string, approvalId?: string): Promise<boolean> {
  if (!bot) return false;

  const idFooter = approvalId ? `\n\n<i>🆔 ${escapeHTML(approvalId)}</i>` : '';
  const text = message + idFooter;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sent = await callWithTimeout(() => bot!.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
      }));
      if (tweetId) {
        storeSentTgMessage(chatId, sent.message_id, tweetId);
      }
      logger.info("Telegram", `以文本形式发送 ${label} (${chatId})`);
      return true;
    } catch (error) {
      logger.error("Telegram", `文本发送尝试 ${attempt}/3 失败, ${label}:`, (error as Error).message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
      }
    }
  }
  return false;
}

export async function sendBatchToTelegram(tweets: ProcessedTweet[]): Promise<number> {
  let sent = 0;

  for (const tweet of tweets) {
    const success = await sendToTelegram(tweet);
    if (success) {
      sent++;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return sent;
}

export async function shutdownTelegram(): Promise<void> {
  if (bot) {
    bot.stop('关闭');
    bot = null;
    logger.info("Telegram", "Telegram bot 已停止");
  }
}
