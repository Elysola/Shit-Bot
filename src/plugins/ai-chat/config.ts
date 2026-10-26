import { getConfig } from '@/config';
import { logger } from '@/logger';
import type { PluginConfigEntry } from '@/types';

// ─── 配置类型 ──────────────────────────────────────────────────────────

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
  /** @everyone / @here 不算叫到 bot（默认 true） */
  ignoreEveryoneMention: boolean;
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

// ─── 规范化 ────────────────────────────────────────────────────────────

/** 把配置里的数值安全转成 [min,max] 内的有限整数；非法(NaN/负数/超大/非数字)时回退默认值。
 *  防止坏配置(尤其经 WebUI 保存)把 SQLite LIMIT 变成负数=无限读、或让工具循环/各类上限失控。 */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function clampFloat(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(n, max));
}

function obj(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

/** 原样保留字符串（不 trim）：前缀类配置可能有意带尾随空格/换行 */
function str(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def;
}

/** 去掉首尾空白；空串回退默认值。用于 URL、模型名、ID 这类值 */
function trimmed(v: unknown, def: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : def;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function strRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) {
    if (typeof val === 'string' && val.trim()) out[String(k)] = val.trim();
  }
  return out;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

/** "HH:MM-HH:MM"（UTC+8）；格式不对视为未设置 */
function quietHours(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

const VECTOR_BACKENDS: readonly VectorBackendMode[] = ['auto', 'sqlite', 'js'];

/**
 * 把原始 ai 配置规范化为完整的 AIConfig：补默认值、数值钳到合法区间、合并环境变量。


/**
 * 把原始 ai 配置规范化为完整的 AIConfig：补默认值、数值钳到合法区间、合并环境变量。
 * 对已规范化的对象再调用一次结果不变（幂等），WebUI 保存后会再跑一遍，防止半截嵌套对象覆盖掉默认值。
 */
export function normalizeAiConfig(rawAi: unknown): AIConfig {
  const ai = obj(rawAi);
  const mem = obj(ai.memory);
  const observe = obj(mem.observe);
  const extractor = obj(mem.extractor);
  const core = obj(mem.core);
  const context = obj(mem.context);
  const persona = obj(ai.persona);
  const history = obj(ai.history);
  const embedding = obj(ai.embedding);
  const vector = obj(ai.vector);
  const affinity = obj(ai.affinity);
  const affinityDecay = obj(affinity.decay);
  const mood = obj(ai.mood);
  const proactive = obj(ai.proactive);

  return {
    enabled: ai.enabled ?? false,
    apiUrl: process.env.AI_API_URL || ai.apiUrl || 'https://api.openai.com/v1',
    apiKey: process.env.AI_API_KEY || ai.apiKey || '',
    model: ai.model || 'gpt-3.5-turbo',
    systemPrompt: ai.systemPrompt || '你是一个有帮助的助手。',
    maxTokens: clampInt(ai.maxTokens, 1024, 1, 32768),
    temperature: clampFloat(ai.temperature, 0.7, 0, 2),
    allowedGuildIds: ai.allowedGuildIds ?? [],
    maxToolIterations: clampInt(ai.maxToolIterations, 12, 1, 30),
    reactions: ai.reactions ?? true,
    ignoreEveryoneMention: bool(ai.ignoreEveryoneMention, true),
    // 图片改由本机下载后以 base64 内联发给网关，故需限制单图与单次请求的字节量
    maxImageBytes: clampInt(ai.maxImageBytes, 6 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    maxTotalImageBytes: clampInt(ai.maxTotalImageBytes, 12 * 1024 * 1024, 256 * 1024, 40 * 1024 * 1024),
    webSearch: {
      enabled: ai.webSearch?.enabled ?? false,
      provider: ai.webSearch?.provider || 'duckduckgo',
      apiKey: process.env.AI_WEB_SEARCH_API_KEY || ai.webSearch?.apiKey || '',
      baseUrl: ai.webSearch?.baseUrl || '',
      maxResults: clampInt(ai.webSearch?.maxResults, 5, 1, 10),
    },
    memory: {
      enabled: mem.enabled ?? false,
      maxProfileItems: clampInt(mem.maxProfileItems, 12, 1, 200),
      maxProfileChars: clampInt(mem.maxProfileChars, 800, 50, 20000),
      recentTurns: clampInt(mem.recentTurns, 6, 0, 100),
      recallLimit: clampInt(mem.recallLimit, 8, 1, 100),
      logConversations: mem.logConversations ?? true,
      maxConversationsPerUser: clampInt(mem.maxConversationsPerUser, 500, 1, 100000),
      observe: {
        enabled: bool(observe.enabled, true),
        channelDenylist: strList(observe.channelDenylist),
        retentionDays: clampInt(observe.retentionDays, 0, 0, 36500),
        crossGuildMessages: bool(observe.crossGuildMessages, false),
      },
      extractor: {
        model: trimmed(extractor.model, ''),
        apiUrl: trimmed(extractor.apiUrl, ''),
        apiKey: process.env.AI_EXTRACTOR_API_KEY || trimmed(extractor.apiKey, ''),
        windowMessages: clampInt(extractor.windowMessages, 40, 5, 200),
        idleSeconds: clampInt(extractor.idleSeconds, 180, 10, 3600),
        maxWaitMinutes: clampInt(extractor.maxWaitMinutes, 30, 1, 1440),
        images: bool(extractor.images, true),
        maxImagesPerWindow: clampInt(extractor.maxImagesPerWindow, 4, 0, 10),
        concurrency: clampInt(extractor.concurrency, 1, 1, 4),
        dailyTokenBudget: clampInt(extractor.dailyTokenBudget, 3_000_000, 0, 1_000_000_000),
      },
      core: {
        userPins: clampInt(core.userPins, 12, 0, 50),
        guildPins: clampInt(core.guildPins, 20, 0, 100),
        selfPins: clampInt(core.selfPins, 10, 0, 50),
        autoPinImportance: clampInt(core.autoPinImportance, 8, 1, 11),
        upcomingDays: clampInt(core.upcomingDays, 7, 0, 60),
      },
      context: {
        speakerChars: clampInt(context.speakerChars, 1200, 200, 20000),
        mentionedChars: clampInt(context.mentionedChars, 500, 100, 10000),
        mentionedUsers: clampInt(context.mentionedUsers, 3, 0, 10),
        guildChars: clampInt(context.guildChars, 1000, 0, 20000),
        selfChars: clampInt(context.selfChars, 600, 0, 10000),
        loreChars: clampInt(context.loreChars, 1000, 0, 20000),
        recentChannelMessages: clampInt(context.recentChannelMessages, 15, 0, 200),
        recentChannelChars: clampInt(context.recentChannelChars, 2000, 0, 50000),
        autoRecall: clampInt(context.autoRecall, 0, 0, 30),
      },
      tools: {
        maxResultChars: clampInt(obj(mem.tools).maxResultChars, 30000, 2000, 200000),
      },
    },
    summary: {
      enabled: ai.summary?.enabled ?? false,
      maxMessagesPerChannel: clampInt(ai.summary?.maxMessagesPerChannel, 500, 1, 100000),
      defaultCount: clampInt(ai.summary?.defaultCount, 100, 1, 100000),
    },
    persona: {
      dir: trimmed(persona.dir, 'data/personas'),
      default: trimmed(persona.default, 'memecat'),
      guilds: strRecord(persona.guilds),
    },
    lore: { dir: trimmed(obj(ai.lore).dir, 'data/lore') },
    history: {
      gapFillOnStartup: bool(history.gapFillOnStartup, true),
      initialDays: clampInt(history.initialDays, 30, 0, 3650),
      maxMessagesPerChannel: clampInt(history.maxMessagesPerChannel, 5000, 0, 1_000_000),
      includeThreads: bool(history.includeThreads, true),
      archivedThreadDays: clampInt(history.archivedThreadDays, 30, 0, 3650),
      requestIntervalMs: clampInt(history.requestIntervalMs, 350, 0, 10000),
    },
    embedding: {
      apiUrl: trimmed(embedding.apiUrl, ''),
      apiKey: process.env.AI_EMBEDDING_API_KEY || trimmed(embedding.apiKey, ''),
      model: trimmed(embedding.model, ''),
      dimensions: clampInt(embedding.dimensions, 0, 0, 8192),
      batchSize: clampInt(embedding.batchSize, 32, 1, 256),
      timeoutMs: clampInt(embedding.timeoutMs, 8000, 1000, 120000),
      queryPrefix: str(embedding.queryPrefix, ''),
      documentPrefix: str(embedding.documentPrefix, ''),
    },
    vector: {
      backend: oneOf(vector.backend, VECTOR_BACKENDS, 'auto'),
      extensionPath: trimmed(vector.extensionPath, ''),
      customSqlitePath: trimmed(vector.customSqlitePath, ''),
      exactThreshold: clampInt(vector.exactThreshold, 3000, 100, 1_000_000),
      coarseK: clampInt(vector.coarseK, 200, 10, 5000),
    },
    affinity: {
      enabled: bool(affinity.enabled, true),
      maxGainPerInteraction: clampInt(affinity.maxGainPerInteraction, 5, 0, 100),
      maxLossPerInteraction: clampInt(affinity.maxLossPerInteraction, 8, 0, 100),
      dailyGainCap: clampInt(affinity.dailyGainCap, 15, 0, 200),
      dailyLossCap: clampInt(affinity.dailyLossCap, 30, 0, 200),
      decay: {
        enabled: bool(affinityDecay.enabled, true),
        afterDays: clampInt(affinityDecay.afterDays, 14, 1, 3650),
        pointsPerWeek: clampInt(affinityDecay.pointsPerWeek, 1, 0, 100),
      },
    },
    mood: {
      enabled: bool(mood.enabled, true),
      valenceHalfLifeHours: clampFloat(mood.valenceHalfLifeHours, 3, 0.1, 168),
      arousalHalfLifeHours: clampFloat(mood.arousalHalfLifeHours, 1, 0.1, 168),
      maxUserImpactPerHour: clampFloat(mood.maxUserImpactPerHour, 0.5, 0, 2),
    },
    proactive: {
      enabled: bool(proactive.enabled, true),
      channels: strList(proactive.channels),
      denyChannels: strList(proactive.denyChannels),
      threshold: clampFloat(proactive.threshold, 0.35, 0, 10),
      debounceSeconds: clampInt(proactive.debounceSeconds, 25, 1, 600),
      forceEvalEveryMessages: clampInt(proactive.forceEvalEveryMessages, 20, 2, 500),
      cooldownMinutes: clampInt(proactive.cooldownMinutes, 10, 0, 1440),
      aliasCooldownSeconds: clampInt(proactive.aliasCooldownSeconds, 60, 0, 3600),
      maxPerHourPerChannel: clampInt(proactive.maxPerHourPerChannel, 3, 0, 60),
      maxPerDay: clampInt(proactive.maxPerDay, 40, 0, 10000),
      maxJudgeCallsPerDay: clampInt(proactive.maxJudgeCallsPerDay, 400, 0, 100000),
      quietHours: quietHours(proactive.quietHours),
      allowReactOnly: bool(proactive.allowReactOnly, true),
      judgeModel: trimmed(proactive.judgeModel, ''),
    },
  };
}

// 旧版 KV 记忆的配置项：新的分层记忆不再使用（只在加载配置时提示一次）
const DEPRECATED_MEMORY_KEYS: Record<string, string> = {
  maxProfileItems: 'memory.core.userPins（置顶条数）',
  maxProfileChars: 'memory.context.speakerChars（说话人档案字数）',
  recentTurns: 'memory.context.recentChannelMessages（频道最近消息条数）',
  recallLimit: 'search_memory 的 limit 参数（由模型按需指定）',
  logConversations: 'memory.observe.enabled（所有消息统一入库）',
  maxConversationsPerUser: 'memory.observe.retentionDays（原始消息保留天数）',
};

function warnDeprecatedAiKeys(rawAi: unknown, where: string): void {
  const mem = obj(obj(rawAi).memory);
  for (const [key, replacement] of Object.entries(DEPRECATED_MEMORY_KEYS)) {
    if (key in mem) logger.warn('Config', `${where}.memory.${key} 已废弃，不再生效；对应的新配置：${replacement}`);
  }
}

// ─── 读取 ──────────────────────────────────────────────────────────────

export const AI_PLUGIN_NAME = 'ai-chat';

// 没有任何 AI 配置时的固定空对象（规范化结果按来源对象缓存，必须是同一个对象）
const EMPTY: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;
const cache = new WeakMap<object, AIConfig>();
const warned = new WeakSet<object>();

/** 插件配置条目 plugins[ai-chat] */
function pluginEntry(): PluginConfigEntry | undefined {
  return (getConfig().plugins || []).find((p) => p.name === AI_PLUGIN_NAME);
}

/**
 * 原始 AI 配置：plugins[ai-chat].options；没写时兼容旧版的顶层 ai:（启动时提示迁移）。
 * 返回的是配置里的原对象，规范化结果按它缓存——WebUI 保存后配置对象换了，自然重新规范化。
 */
function rawAiConfig(): { raw: Record<string, unknown>; where: string } {
  const options = pluginEntry()?.options;
  if (options && Object.keys(options).length > 0) return { raw: options, where: `plugins[${AI_PLUGIN_NAME}].options` };
  const legacy = (getConfig() as { ai?: unknown }).ai;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) return { raw: legacy as Record<string, unknown>, where: 'ai' };
  return { raw: EMPTY, where: `plugins[${AI_PLUGIN_NAME}].options` };
}

/**
 * 当前生效的 AI 配置（运行时读取：WebUI 改了立即生效）。
 * 同一份原始配置只规范化一次，返回同一个对象；插件被 enabled: false 关掉时 enabled 一律为 false。
 */
export function getAiConfig(): AIConfig {
  const { raw, where } = rawAiConfig();
  let cfg = cache.get(raw);
  if (!cfg) {
    cfg = normalizeAiConfig(raw);
    if (!warned.has(raw)) {
      warned.add(raw);
      if (where === 'ai') logger.warn('Config', `AI 配置写在旧的顶层 ai: 下，仍然生效；建议移到 plugins[${AI_PLUGIN_NAME}].options（见 docs/plugins/ai-chat/）`);
      warnDeprecatedAiKeys(raw, where);
      if (cfg.enabled && !cfg.apiKey) logger.warn('Config', 'AI 聊天已启用但未配置 API Key，将禁用 AI 聊天');
    }
    if (cfg.enabled && !cfg.apiKey) cfg.enabled = false;
    cache.set(raw, cfg);
  }
  return pluginEntry()?.enabled === false && cfg.enabled ? { ...cfg, enabled: false } : cfg;
}

/** 兼容旧接口：配置按来源对象缓存，不需要手动失效 */
export function invalidateAiConfigCache(): void {}
