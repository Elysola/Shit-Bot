import { Tweet, FilterConfig, UserConfig, ProcessedTweet } from '@/types';

export function applyFilters(tweet: Tweet, userConfig: UserConfig): ProcessedTweet {
  const filters = userConfig.filters;
  const reasons: string[] = [];
  let passed = true;

  if (!filters) {
    return {
      ...tweet,
      matchedUser: userConfig,
      passedFilters: true,
      filterReasons: [],
    };
  }

  if (filters.excludeRetweets && tweet.isRetweet) {
    passed = false;
    reasons.push('是转推');
  }

  if (filters.excludeReplies && tweet.isReply) {
    passed = false;
    reasons.push('是回复');
  }

  if (filters.keywords) {
    const contentLower = tweet.content.toLowerCase();

    if (filters.keywords.include && filters.keywords.include.length > 0) {
      const hasIncludedKeyword = filters.keywords.include.some(
        (keyword) => contentLower.includes(keyword.toLowerCase())
      );
      if (!hasIncludedKeyword) {
        passed = false;
        reasons.push('缺少必要关键词');
      }
    }

    if (filters.keywords.exclude && filters.keywords.exclude.length > 0) {
      const hasExcludedKeyword = filters.keywords.exclude.some(
        (keyword) => contentLower.includes(keyword.toLowerCase())
      );
      if (hasExcludedKeyword) {
        passed = false;
        reasons.push('包含排除关键词');
      }
    }
  }

  if (filters.media?.requireMedia && tweet.mediaUrls.length === 0) {
    passed = false;
    reasons.push('无媒体附件');
  }

  return {
    ...tweet,
    matchedUser: userConfig,
    passedFilters: passed,
    filterReasons: reasons,
  };
}

export function filterTweets(tweets: Tweet[], userConfig: UserConfig): ProcessedTweet[] {
  return tweets.map((tweet) => applyFilters(tweet, userConfig));
}

export function getPassedTweets(processedTweets: ProcessedTweet[]): ProcessedTweet[] {
  return processedTweets.filter((tweet) => tweet.passedFilters);
}

export function formatTweetMessage(tweet: ProcessedTweet): string {
  const lines: string[] = [];

  lines.push(`🐦 **@${tweet.author}** (${tweet.authorName})`);
  lines.push('');
  lines.push(tweet.content);
  lines.push('');
    lines.push(`🔗 ${tweet.url}`);
    lines.push(`📅 ${tweet.publishedAt.toLocaleString()}`);

    if (tweet.mediaUrls.length > 0) {
      lines.push(`📎 ${tweet.mediaUrls.length} 个媒体附件`);
    }

    return lines.join('\n');
  }

  export function formatTweetHTML(tweet: ProcessedTweet): string {
    const lines: string[] = [];

    lines.push(`<b>🐦 @${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`);
    lines.push('');
    lines.push(formatContentHTML(tweet.content));
    lines.push('');
    lines.push(`<a href="${tweet.url}">🔗 在 X 上查看</a>`);
    lines.push(`📅 ${tweet.publishedAt.toLocaleString()}`);

    if (tweet.mediaUrls.length > 0) {
      lines.push(`📎 ${tweet.mediaUrls.length} 个媒体附件`);
    }

  return lines.join('\n');
}

function formatContentHTML(content: string): string {
  const placeholderMap: string[] = [];

  const withPlaceholders = content.replace(
    /https?:\/\/t\.co\/\w+/g,
    (url) => {
      const idx = placeholderMap.length;
      placeholderMap.push(`<a href="${url}">🔗 链接</a>`);
      return `__TCO_PH_${idx}__`;
    }
  );

  const escaped = withPlaceholders
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return escaped.replace(/__TCO_PH_(\d+)__/g, (_, idx) => placeholderMap[parseInt(idx)]);
}

function formatContentDiscord(content: string): string {
  return content.replace(
    /https?:\/\/t\.co\/\w+/g,
    (url) => `[🔗 链接](${url})`
  );
}

export function formatContentForPlatform(content: string, platform: 'html' | 'discord' | 'onebot'): string {
  if (platform === 'html') return formatContentHTML(content);
  if (platform === 'discord') return formatContentDiscord(content);
  return content;
}

export function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
