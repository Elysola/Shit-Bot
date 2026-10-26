import { ProcessedTweet } from '@/types';
import { getConfig } from '@/config';
import { logger } from '@/logger';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

async function fetchWithRetry(url: string, headers: Record<string, string>, tweetId: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { headers });
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        logger.warn("XToImage", `X to Image API 第 ${attempt + 1} 次尝试失败, 推文 ${tweetId}, ${RETRY_DELAYS[attempt]}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
      }
    }
  }

  throw lastError;
}

export async function fetchTweetImage(tweet: ProcessedTweet): Promise<Buffer | null> {
  const config = getConfig();

  if (!config.xToImageApiUrl) {
    return null;
  }

  try {
    const url = new URL('/api/convert', config.xToImageApiUrl);
    url.searchParams.set('url', tweet.url);
    url.searchParams.set('theme', config.xToImageApiTheme || 'dark');

    const headers: Record<string, string> = {};
    if (config.xToImageApiToken) {
      headers['Authorization'] = `Bearer ${config.xToImageApiToken}`;
    }

    const response = await fetchWithRetry(url.toString(), headers, tweet.id);

    if (!response.ok) {
      logger.error("XToImage", `X to Image API 返回 ${response.status}: ${response.statusText}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    logger.error("XToImage", `从 X to Image API 获取图片失败, 推文 ${tweet.id}:`, error);
    return null;
  }
}
