export interface Tweet {
  id: string;
  author: string;
  authorName: string;
  content: string;
  url: string;
  publishedAt: Date;
  mediaUrls: string[];
  isRetweet: boolean;
  isReply: boolean;
}

export interface FilterConfig {
  keywords?: {
    include?: string[];
    exclude?: string[];
  };
  engagement?: {
    minLikes?: number;
    minRetweets?: number;
    minReplies?: number;
  };
  media?: {
    requireMedia?: boolean;
    allowedTypes?: ('image' | 'video' | 'gif')[];
  };
  excludeRetweets?: boolean;
  excludeReplies?: boolean;
}

export interface UserConfig {
  username: string;
  displayName?: string;
  filters?: FilterConfig;
}

/** auto = 登录前读取应用标志位，后台开了就订阅；on = 强制订阅；off = 不订阅 */
export type PrivilegedIntentMode = 'auto' | 'on' | 'off';

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  adminChannelId?: string;
  approveRoleId?: string;
  embedColor?: string;
  privilegedIntents: {
    members: PrivilegedIntentMode;
    presences: PrivilegedIntentMode;
  };
}

export interface TelegramTarget {
  chatId: string;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  adminChatIds?: string[];
  parseMode?: 'HTML' | 'Markdown';
  apiRoot?: string;
}

export interface TwitterConfig {
  enabled?: boolean;
  authToken: string;
  ct0: string;
  username?: string;
  password?: string;
  email?: string;
  totpSecret?: string;
}

export interface AIWebSearchConfig {
  enabled: boolean;
  provider?: 'duckduckgo' | 'tavily' | 'serper' | 'searxng' | 'brave';
  apiKey?: string;
  baseUrl?: string;
  maxResults?: number;
}

export interface AISummaryConfig {
  enabled: boolean;
  maxMessagesPerChannel?: number;
  defaultCount?: number;
}

export type AIMemoryObserveConfig = {
  enabled: boolean;
  channelDenylist: string[];
  /** 原始消息保留天数，0 = 永久 */
  retentionDays: number;
  /** 是否允许模型跨服务器读取某人的原话 */
  crossGuildMessages: boolean;
};

export type AIMemoryExtractorConfig = {
  /** 空字符串 = 沿用 ai.model / ai.apiUrl / ai.apiKey */
  model: string;
  apiUrl: string;
  apiKey: string;
  windowMessages: number;
  idleSeconds: number;
  maxWaitMinutes: number;
  images: boolean;
  maxImagesPerWindow: number;
  concurrency: number;
  /** 抽取类后台任务每天的 token 上限，0 = 不限 */
  dailyTokenBudget: number;
};

export type AIMemoryCoreConfig = {
  userPins: number;
  guildPins: number;
  selfPins: number;
  /** 重要度 ≥ 该值的新记忆自动置顶；11 = 永不自动置顶 */
  autoPinImportance: number;
  upcomingDays: number;
};

export type AIMemoryContextConfig = {
  speakerChars: number;
  mentionedChars: number;
  mentionedUsers: number;
  guildChars: number;
  selfChars: number;
  loreChars: number;
  recentChannelMessages: number;
  recentChannelChars: number;
  /** 每轮自动附带的 T2 相关记忆条数，0 = 只靠工具 */
  autoRecall: number;
};

export interface AIMemoryConfig {
  enabled: boolean;
  maxProfileItems?: number;
  maxProfileChars?: number;
  recentTurns?: number;
  recallLimit?: number;
  logConversations?: boolean;
  maxConversationsPerUser?: number;
  observe: AIMemoryObserveConfig;
  extractor: AIMemoryExtractorConfig;
  core: AIMemoryCoreConfig;
  context: AIMemoryContextConfig;
  tools: { maxResultChars: number };
}

export type AIPersonaConfig = {
  dir: string;
  default: string;
  /** guildId → personaId */
  guilds: Record<string, string>;
};

export type AIHistoryConfig = {
  gapFillOnStartup: boolean;
  initialDays: number;
  maxMessagesPerChannel: number;
  includeThreads: boolean;
  archivedThreadDays: number;
  requestIntervalMs: number;
};

export type AIEmbeddingConfig = {
  /** apiUrl 与 model 都非空才启用向量化 */
  apiUrl: string;
  apiKey: string;
  model: string;
  /** 0 = 不传 dimensions 参数，用模型默认维度 */
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
  queryPrefix: string;
  documentPrefix: string;
};

export type VectorBackendMode = 'auto' | 'sqlite' | 'js';

export type AIVectorConfig = {
  backend: VectorBackendMode;
  extensionPath: string;
  customSqlitePath: string;
  exactThreshold: number;
  coarseK: number;
};

export type AIAffinityConfig = {
  enabled: boolean;
  maxGainPerInteraction: number;
  maxLossPerInteraction: number;
  dailyGainCap: number;
  dailyLossCap: number;
  decay: { enabled: boolean; afterDays: number; pointsPerWeek: number };
};

export type AIMoodConfig = {
  enabled: boolean;
  valenceHalfLifeHours: number;
  arousalHalfLifeHours: number;
  maxUserImpactPerHour: number;
};

export type AIProactiveConfig = {
  enabled: boolean;
  /** 白名单；空 = 所有被观察的频道 */
  channels: string[];
  denyChannels: string[];
  threshold: number;
  debounceSeconds: number;
  forceEvalEveryMessages: number;
  cooldownMinutes: number;
  aliasCooldownSeconds: number;
  maxPerHourPerChannel: number;
  maxPerDay: number;
  maxJudgeCallsPerDay: number;
  /** "HH:MM-HH:MM"（UTC+8），空 = 按人设作息 */
  quietHours: string;
  allowReactOnly: boolean;
  /** 空 = 沿用 extractor.model */
  judgeModel: string;
};

export interface AIConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  allowedGuildIds?: string[];
  maxToolIterations?: number;
  reactions?: boolean;
  // 单张图片内联(base64)时允许的原始字节上限；超过则跳过该图
  maxImageBytes?: number;
  // 单次请求所有内联图片的原始字节总预算；防止请求体过大被网关 400
  maxTotalImageBytes?: number;
  webSearch?: AIWebSearchConfig;
  memory: AIMemoryConfig;
  summary?: AISummaryConfig;
  persona: AIPersonaConfig;
  lore: { dir: string };
  history: AIHistoryConfig;
  embedding: AIEmbeddingConfig;
  vector: AIVectorConfig;
  affinity: AIAffinityConfig;
  mood: AIMoodConfig;
  proactive: AIProactiveConfig;
}

export interface WebUIConfig {
  enabled: boolean;
  port: number;
  host: string;
  password?: string;
}

export interface AppConfig {
  users?: UserConfig[];
  discord: DiscordConfig;
  telegram: TelegramConfig;
  twitter: TwitterConfig;
  webui: WebUIConfig;
  ai: AIConfig;
  enableApproval: boolean;
  sendAsImage: boolean;
  xToImageApiUrl?: string;
  xToImageApiToken?: string;
  xToImageApiTheme?: 'light' | 'dim' | 'dark';
  imageCacheTtlMinutes: number;
  pollIntervalMinutes: number;
  maxPostsPerFetch: number;
  maxTweetAgeMinutes: number;
  groups?: GroupConfig[];
}

export interface GroupTelegramConfig {
  chatId: string;
  targets?: Record<string, { chatId: string }>;
}

export interface GroupDiscordConfig {
  channelId: string;
  r14ChannelId?: string;
}

export interface GroupApprovalConfig {
  telegramAdminChatIds?: string[];
  discordAdminChannelId?: string;
  discordApproveRoleId?: string;
}

export interface GroupConfig {
  name: string;
  users?: UserConfig[];
  telegram?: GroupTelegramConfig;
  discord?: GroupDiscordConfig;
  approval?: GroupApprovalConfig;
  blockedUsers?: string[];
}

export interface ProcessedTweet extends Tweet {
  matchedUser: UserConfig;
  passedFilters: boolean;
  filterReasons: string[];
}
