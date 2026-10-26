import { Tweet, UserConfig } from '@/types';
import { getConfig } from '@/config';
import { isAlreadySent, isTooOld, markAsSent } from '@/storage';
import { fetchTweetsForUser as fetchTweetsViaApi, fetchAllTweets as fetchAllTweetsViaApi } from '@/twitter/client';
import { logger } from '@/logger';

export async function fetchTweetsForUser(user: UserConfig): Promise<Tweet[]> {
  const config = getConfig();

  try {
    const tweets = await fetchTweetsViaApi(user);
    const filteredTweets: Tweet[] = [];

    for (const tweet of tweets) {
      if (isAlreadySent(tweet.id)) {
        continue;
      }

      if (isNaN(tweet.publishedAt.getTime()) || isTooOld(tweet.publishedAt, config.maxTweetAgeMinutes)) {
        continue;
      }

      filteredTweets.push(tweet);
    }

    return filteredTweets;
  } catch (error) {
    logger.error("RSS", `获取 @${user.username} 的推文失败:`, error);
    return [];
  }
}

export async function fetchAllTweets(): Promise<Map<string, Tweet[]>> {
  const config = getConfig();
  const results = new Map<string, Tweet[]>();

  const rawResults = await fetchAllTweetsViaApi();

  for (const [username, tweets] of rawResults) {
    const filteredTweets: Tweet[] = [];

    for (const tweet of tweets) {
      if (isAlreadySent(tweet.id)) {
        continue;
      }

      if (isNaN(tweet.publishedAt.getTime()) || isTooOld(tweet.publishedAt, config.maxTweetAgeMinutes)) {
        continue;
      }

      filteredTweets.push(tweet);
    }

    results.set(username, filteredTweets);
  }

  return results;
}

export function markTweetsAsSent(tweets: Tweet[]): void {
  for (const tweet of tweets) {
    markAsSent(tweet.id);
  }
}
