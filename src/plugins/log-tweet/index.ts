import { logger } from '@/logger';
import type { PluginDefinition } from "@/plugins/types";

export default {
  manifest: {
    name: "log-tweet",
    version: "1.0.0",
    description: "记录每条推文到本地日志文件",
    author: "shit-bot",
  },
  init: (api) => {
    api.logger.info("log-tweet 插件已初始化");
  },
  hooks: {
    onTweetReceived: (tweet) => {
      logger.info("LogTweet", `收到推文: @${tweet.author} - ${tweet.content.slice(0, 80)}`);
      return tweet;
    },
    onAfterInit: () => {
      logger.info("LogTweet", "bot 初始化完成");
    },
  },
  configSchema: {
    logFile: { type: "string", default: "./data/tweets.log" },
  },
} satisfies PluginDefinition;
