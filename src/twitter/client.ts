import { TwitterOpenApi, TwitterOpenApiClient } from 'twitter-openapi-typescript';
import { TweetApiUtilsData, UserApiUtilsData } from 'twitter-openapi-typescript/dist/src/models';
import { getConfig, getEffectiveGroups } from '@/config';
import { Tweet, UserConfig } from '@/types';
import { logger } from '@/logger';

let client: TwitterOpenApiClient | null = null;
const userIdCache = new Map<string, string>();

export async function initTwitterClient(): Promise<boolean> {
  const config = getConfig();
  const { authToken, ct0 } = config.twitter;

  const api = new TwitterOpenApi();

  const originalFetch = TwitterOpenApi.fetchApi;
  TwitterOpenApi.fetchApi = (url: string, init?: any) => {
    const opts = init || {};
    if ((globalThis as any).Bun) {
      opts.tls = { rejectUnauthorized: false };
    }
    return originalFetch(url, opts);
  };

  if (authToken && ct0) {
    try {
      client = await api.getClientFromCookies({
        ct0,
        auth_token: authToken,
      });
      logger.info("Twitter", "Twitter API 客户端已初始化 (Cookie 认证)");
      return true;
    } catch (error) {
      logger.error("Twitter", "Twitter 客户端 Cookie 初始化失败:", error);
      client = null;
    }
  }

  try {
    client = await api.getGuestClient();
    logger.info("Twitter", "Twitter API 客户端已初始化 (访客模式)");
    return true;
  } catch (error) {
    logger.error("Twitter", "Twitter 访客客户端初始化失败:", error);
    client = null;
    return false;
  }
}

export function getTwitterClient(): TwitterOpenApiClient | null {
  return client;
}

export async function getUserIdByUsername(username: string): Promise<string | null> {
  if (userIdCache.has(username)) {
    return userIdCache.get(username)!;
  }

  if (!client) {
    logger.error("Twitter", "Twitter 客户端未初始化");
    return null;
  }

  try {
    const response = await client.getUserApi().getUserByScreenName({ screenName: username });
    const user = response.data.user;
    if (!user) {
      logger.warn("Twitter", `用户 @${username} 未找到`);
      return null;
    }

    userIdCache.set(username, user.restId);
    return user.restId;
  } catch (error) {
    logger.error("Twitter", `获取 @${username} 的用户 ID 失败:`, error);
    return null;
  }
}

function extractMediaUrls(tweetData: TweetApiUtilsData): string[] {
  const urls: string[] = [];
  const legacy = tweetData.tweet.legacy;

  if (!legacy) return urls;

  const extendedEntities = legacy.extendedEntities;
  if (extendedEntities?.media) {
    for (const media of extendedEntities.media) {
      if (media.type === 'photo') {
        urls.push(media.mediaUrlHttps);
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const variants = media.videoInfo?.variants;
        if (variants && variants.length > 0) {
          const mp4Variant = variants
            .filter((v) => v.contentType === 'video/mp4')
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (mp4Variant?.url) {
            urls.push(mp4Variant.url);
          }
        }
      }
    }
  }

  return urls;
}

function convertToTweet(tweetData: TweetApiUtilsData, userConfig: UserConfig): Tweet | null {
  const legacy = tweetData.tweet.legacy;
  const user = tweetData.user;

  if (!legacy || !user?.core) return null;

  const isRetweet = !!tweetData.retweeted || legacy.fullText.startsWith('RT @');
  const isReply = !!legacy.inReplyToStatusIdStr;

  const createdAt = new Date(legacy.createdAt);

  return {
    id: tweetData.tweet.restId || legacy.idStr,
    author: user.core.screenName,
    authorName: user.core.name || userConfig.displayName || user.core.screenName,
    content: legacy.fullText,
    url: `https://x.com/${user.core.screenName}/status/${tweetData.tweet.restId || legacy.idStr}`,
    publishedAt: createdAt,
    mediaUrls: extractMediaUrls(tweetData),
    isRetweet,
    isReply,
  };
}

export async function fetchTweetsForUser(userConfig: UserConfig): Promise<Tweet[]> {
  if (!client) {
    logger.error("Twitter", "Twitter 客户端未初始化");
    return [];
  }

  const config = getConfig();

  try {
    const userId = await getUserIdByUsername(userConfig.username);
    if (!userId) {
      logger.warn("Twitter", `未找到用户 @${userConfig.username} 的 ID`);
      return [];
    }

    const response = await client.getTweetApi().getUserTweets({
      userId,
      count: config.maxPostsPerFetch,
    });

    const tweets: Tweet[] = [];

    for (const tweetData of response.data.data) {
      if (tweetData.promotedMetadata) continue;

      const tweet = convertToTweet(tweetData, userConfig);
      if (tweet) {
        tweets.push(tweet);
      }
    }

    return tweets;
  } catch (error) {
    logger.error("Twitter", `获取 @${userConfig.username} 的推文失败:`, error);
    return [];
  }
}

export async function fetchAllTweets(): Promise<Map<string, Tweet[]>> {
  const groups = getEffectiveGroups();
  const uniqueUsers = new Map<string, UserConfig>();

  for (const g of groups) {
    for (const u of (g.users || [])) {
      if (!uniqueUsers.has(u.username)) {
        uniqueUsers.set(u.username, u);
      }
    }
  }

  const results = new Map<string, Tweet[]>();

  for (const [username, user] of uniqueUsers) {
    const tweets = await fetchTweetsForUser(user);
    results.set(username, tweets);

    if (tweets.length > 0) {
      logger.info("Twitter", `从 @${username} 获取到 ${tweets.length} 条推文`);
    }
  }

  return results;
}
