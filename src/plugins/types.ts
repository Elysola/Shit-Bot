import { AppConfig, ProcessedTweet, Tweet, GroupConfig } from "@/types";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
}

export interface PollResult {
  allTweets: Map<string, Tweet[]>;
  totalFetched: number;
  totalProcessed: number;
  totalPassed: number;
  totalSent: number;
  elapsedSeconds: number;
}

export interface SendResult {
  success: boolean;
  target: string;
  error?: string;
}

export interface PluginLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface PluginAPI {
  getConfig: () => AppConfig;
  registerCronJob: (expression: string, handler: () => void | Promise<void>) => void;
  logger: PluginLogger;
  getDatabase: () => any;
  getDiscordClient: () => any;
  getTelegramBot: () => any;
}

export interface PluginHooks {
  onConfigLoaded?: (config: AppConfig) => void | Promise<void>;
  onBeforeInit?: () => void | Promise<void>;
  onAfterInit?: () => void | Promise<void>;
  onBeforeShutdown?: () => void | Promise<void>;
  onBeforePoll?: () => void | Promise<void>;
  onAfterPoll?: (result: PollResult) => void | Promise<void>;
  onTweetReceived?: (tweet: Tweet) => Tweet | null | void | Promise<Tweet | null | void>;
  onBeforeTweetSend?: (
    tweet: ProcessedTweet,
    group: GroupConfig,
  ) => ProcessedTweet | null | void | Promise<ProcessedTweet | null | void>;
  onAfterTweetSend?: (tweet: ProcessedTweet, group: GroupConfig, result: SendResult) => void | Promise<void>;
  onBeforeApproval?: (
    tweet: ProcessedTweet,
    group: GroupConfig,
  ) => ProcessedTweet | null | void | Promise<ProcessedTweet | null | void>;
  onApprovalResult?: (
    tweet: ProcessedTweet,
    group: GroupConfig,
    approved: boolean,
    admin: string,
    targetTag?: string,
  ) => void | Promise<void>;
  onDiscordMessage?: (message: any) => boolean | void | Promise<boolean | void>;
  onTelegramMessage?: (ctx: any) => boolean | void | Promise<boolean | void>;
  onOneBotMessage?: (message: any) => boolean | void | Promise<boolean | void>;
  onDiscordCommands?: () => any[] | Promise<any[]>;
}

export interface PluginConfigEntry {
  name: string;
  enabled: boolean;
  options?: Record<string, any>;
  github?: string;
  ref?: string;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  hooks: PluginHooks;
  init?: (api: PluginAPI) => void | Promise<void>;
  configSchema?: Record<string, any>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  hooks: PluginHooks;
  init?: (api: PluginAPI) => void | Promise<void>;
  config?: PluginConfigEntry;
}
