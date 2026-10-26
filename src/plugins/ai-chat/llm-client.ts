import { logger } from '@/logger';
import { getAiConfig } from './config';
import { getDatabase } from '@/storage';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';
import { dayKeyUtc8 } from './time';
import type { OpenAITool } from './tools';

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

/** 调用用途，用于按天分类统计 token（llm_usage 表）与各自的预算 */
export type LlmPurpose = 'chat' | 'extract' | 'appraise' | 'profile' | 'proactive' | 'embed';

export type LlmTarget = { apiUrl: string; apiKey: string; model: string };

export type LlmHttpError = Error & { status?: number; body?: string; retryAfterMs?: number };

/** 上游限流（429）：后台任务不算失败，推迟到 retryAt 再试 */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAt: number
  ) {
    super(message);
  }
}

/** 模型多次没有给出合格的 JSON：问题出在这批输入上（换个窗口就好），不是配置或网络 */
export class JsonOutputError extends Error {}

// 400 / 422 里和这批输入有关的：内容审核 / 安全拦截、上下文或输入过长。参数不支持之类的配置错误不算
const INPUT_ERROR_TEXT =
  /content[_ -]?(filter|policy|management)|safety|moderation|blocked|sensitive|prohibited|violat|context[_ -]?length|maximum context|prompt is too long|input is too long|too many tokens|token limit/i;

/**
 * 失败是不是这批输入本身造成的（换一批输入就可能成功）：内容审核 / 输入过长（400 / 422 且错误内容说明了这一点、413）、
 * 输出不是合格 JSON。鉴权、参数不支持、模型不可用、限流、5xx、网络、超时都不算——它们和输入无关，等配置或上游恢复。
 */
export function isInputError(e: unknown): boolean {
  if (e instanceof JsonOutputError) return true;
  const err = e as LlmHttpError;
  if (err?.status === 413) return true;
  if (err?.status !== 400 && err?.status !== 422) return false;
  return INPUT_ERROR_TEXT.test(`${err.body ?? ''} ${err.message ?? ''}`);
}

// 后台任务（提炼、画像、互动评估）的请求：按最小间隔排队；收到 429 后全部暂停，连续限流时暂停时间翻倍
const BACKGROUND: ReadonlySet<LlmPurpose> = new Set<LlmPurpose>(['extract', 'profile', 'appraise']);
let lastBackgroundAt = 0;
let pausedUntil = 0;
let rateLimitStreak = 0;

async function waitBackgroundTurn(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const gap = getAiConfig().memory.extractor.minIntervalMs;
    // 系统时钟往回调时，上次请求时间按"现在"算，避免空等
    const last = Math.min(lastBackgroundAt, now);
    const wait = Math.max(pausedUntil - now, gap > 0 ? last + gap - now : 0);
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
  }
  lastBackgroundAt = Date.now();
}

/** 测试用：清掉限流暂停与节流状态 */
export function resetRateLimitForTesting(): void {
  lastBackgroundAt = 0;
  pausedUntil = 0;
  rateLimitStreak = 0;
}

export type ChatRequest = {
  target: LlmTarget;
  purpose: LlmPurpose;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: OpenAITool[];
  /** 默认 'auto'；false = 本次请求不附带 tools */
  toolChoice?: 'auto' | 'none' | false;
  responseFormat?: { type: 'json_object' };
  /** 单次请求超时，默认 60s */
  timeoutMs?: number;
  /** 最多尝试次数，默认 3（超时类错误另有上限 2） */
  maxAttempts?: number;
  /** 重试退避基数：第 n 次重试等待 n × 该值（默认 600ms，上限 10s）；测试里调小 */
  retryBaseMs?: number;
};

/** 当前聊天配置对应的调用目标 */
export function chatTarget(): LlmTarget {
  const ai = getAiConfig();
  return { apiUrl: ai.apiUrl, apiKey: ai.apiKey, model: ai.model };
}

/** 后台抽取/评估/画像所用的调用目标：extractor 的各项留空时沿用聊天配置 */
export function extractorTarget(): LlmTarget {
  const ai = getAiConfig();
  const ex = ai.memory.extractor;
  return {
    apiUrl: ex.apiUrl || ai.apiUrl,
    apiKey: ex.apiKey || ai.apiKey,
    model: ex.model || ai.model,
  };
}

/** 主动插话判断所用的调用目标：judgeModel 留空时沿用 extractor */
export function judgeTarget(): LlmTarget {
  const ex = extractorTarget();
  return { ...ex, model: getAiConfig().proactive.judgeModel || ex.model };
}

// 上游网关"拉取/下载图片失败"类错误的特征。图片现已由本机下载后 base64 内联（见 chat.ts 的 loadImageDataUri），
// 网关无需联网取图，正常情况下不会再出现这类错误；保留它仅作兜底：万一仍命中(如内联失败漏网、
// 或网关对 data URI 另有限制)，按永久性处理——重试无用，正确做法是去掉图片改用纯文本重试。
export function isImageFetchError(err: { status?: number; body?: string; message?: string }): boolean {
  const s = `${err.body || ''} ${err.message || ''}`.toLowerCase();
  return /get file data|file data from|download file|failed to download|convert_request_failed/.test(s);
}

// 把模型/网关返回的 content 安全转成字符串：可能是 string、内容块数组、或异常类型(对象/null)，
// 直接 .trim() 会抛。统一在这里窄化，避免一条畸形响应让整轮处理崩掉。
export function contentToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p: unknown) => {
        const text = p && typeof p === 'object' ? (p as { text?: unknown }).text : undefined;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

function logPrefix(purpose: LlmPurpose): string {
  return purpose === 'chat' ? '[AI]' : `[AI:${purpose}]`;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions。
 * 可重试：网络层错误(无状态码)、超时、408、429、5xx；不重试：其它 4xx 与"上游拉取图片失败"。
 * 超时每次都要干等满 timeoutMs，重试代价高，最多只重试 1 次。成功后按用途记录 token 用量。
 */
export async function chatCompletion(req: ChatRequest): Promise<ChatCompletionResponse> {
  const { target } = req;
  const body: Record<string, unknown> = {
    model: target.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  const tools = req.tools ?? [];
  const toolChoice = req.toolChoice ?? 'auto';
  if (toolChoice !== false && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  if (req.responseFormat) body.response_format = req.responseFormat;

  const maxAttempts = req.maxAttempts ?? 3;
  const timeoutMs = req.timeoutMs ?? 60000;
  const retryBaseMs = req.retryBaseMs ?? 600;
  let lastErr: unknown;

  const background = BACKGROUND.has(req.purpose);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (background) await waitBackgroundTurn();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${target.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`HTTP ${response.status}: ${errorText}`) as LlmHttpError;
        err.status = response.status;
        err.body = errorText;
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const secs = Number(retryAfter);
          if (Number.isFinite(secs) && secs >= 0) err.retryAfterMs = secs * 1000;
        }
        throw err;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      recordUsage(req.purpose, target.model, data.usage);
      if (background) rateLimitStreak = 0;
      return data;
    } catch (e) {
      const err = e as LlmHttpError;
      const status = err.status || 0;
      const isTimeout = err.name === 'AbortError';
      if (background && status === 429) {
        // 后台任务撞上限流：马上重试只会继续被拒。所有后台请求一起暂停，任务推迟到暂停结束，不算失败
        const pause = err.retryAfterMs ?? Math.min(30_000 * 2 ** rateLimitStreak, 10 * 60_000);
        rateLimitStreak++;
        pausedUntil = Math.max(pausedUntil, Date.now() + pause);
        logger.warn('AI', `${logPrefix(req.purpose)} 被上游限流，后台任务暂停 ${Math.round(pause / 1000)}s`);
        throw new RateLimitedError(err.message, pausedUntil);
      }
      const retryable =
        (!status || isTimeout || status === 408 || status === 429 || status >= 500) && !isImageFetchError(err);
      const attemptCap = isTimeout ? Math.min(2, maxAttempts) : maxAttempts;
      if (!retryable || attempt >= attemptCap) throw e;
      lastErr = e;
      const wait = Math.min(err.retryAfterMs ?? retryBaseMs * attempt, 10000);
      const reason = isTimeout ? '请求超时' : err.message;
      logger.warn('AI', `${logPrefix(req.purpose)} 瞬时错误，${wait}ms 后重试 ${attempt}/${attemptCap - 1}: ${reason}`);
      await new Promise((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastErr;
}

function nonNegInt(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 累加一次调用的 token 用量到 llm_usage（按 UTC+8 自然日 × 用途 × 模型）。记账失败只告警，不影响调用方。 */
export function recordUsage(
  purpose: LlmPurpose,
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  now: number = Date.now()
): void {
  if (!isAiSchemaReady()) return;
  try {
    getDatabase().run(
      `INSERT INTO llm_usage (day, purpose, model, calls, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day, purpose, model) DO UPDATE SET
         calls = calls + 1,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens`,
      [dayKeyUtc8(now), purpose, model, nonNegInt(usage?.prompt_tokens), nonNegInt(usage?.completion_tokens)]
    );
  } catch (e) {
    logger.warn('AI', '记录 token 用量失败(忽略):', (e as Error).message);
  }
}

/** 今天（UTC+8）已用的 token 总数（输入 + 输出）；purposes 为空表示所有用途。 */
export function getTokensUsedToday(purposes: readonly LlmPurpose[] = [], now: number = Date.now()): number {
  if (!isAiSchemaReady()) return 0;
  const day = dayKeyUtc8(now);
  const filter = purposes.length > 0 ? ` AND purpose IN (${purposes.map(() => '?').join(',')})` : '';
  const row = getDatabase()
    .query(`SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM llm_usage WHERE day = ?${filter}`)
    .get(day, ...purposes) as { t: number };
  return row.t;
}

/** 从模型输出里尽量取出 JSON：整段 → ```json 代码块 → 第一个 { 到最后一个 }。都失败返回 undefined。 */
export function parseJsonLoose(text: string): unknown {
  const s = String(text || '').trim();
  if (!s) return undefined;
  const candidates = [s];
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 继续尝试下一种
    }
  }
  return undefined;
}

export type JsonRequest<T> = Omit<ChatRequest, 'tools' | 'toolChoice' | 'responseFormat'> & {
  /** 把解析出的 JSON 校验并收窄成 T；不合格返回 null（会触发纠错重试） */
  validate: (value: unknown) => T | null;
  /** 解析或校验失败后带纠错提示重试的次数，默认 1 */
  repairAttempts?: number;
};

// 记住哪些网关/模型不支持 response_format，之后直接走普通输出 + 宽松解析
const jsonModeUnsupported = new Set<string>();

/**
 * 请求一个结构化 JSON 结果。优先使用 response_format=json_object；网关明确拒绝该参数(400)时自动降级。
 * 输出无法解析或未通过 validate 时，带着纠错提示重试 repairAttempts 次，仍失败则抛错（调用方不应写入半成品）。
 */
export async function jsonCompletion<T>(req: JsonRequest<T>): Promise<T> {
  const { validate, repairAttempts = 1, ...base } = req;
  const messages: ChatMessage[] = [...base.messages];
  const key = `${base.target.apiUrl}|${base.target.model}`;

  for (let round = 0; round <= repairAttempts; round++) {
    const useJsonMode = !jsonModeUnsupported.has(key);
    let data: ChatCompletionResponse;
    try {
      data = await chatCompletion({
        ...base,
        messages,
        toolChoice: false,
        responseFormat: useJsonMode ? { type: 'json_object' } : undefined,
      });
    } catch (e) {
      const err = e as LlmHttpError;
      const rejectedJsonMode =
        useJsonMode && err.status === 400 && /response_format|json_object/i.test(`${err.body || ''} ${err.message}`);
      if (!rejectedJsonMode) throw e;
      jsonModeUnsupported.add(key);
      logger.warn('AI', `${logPrefix(base.purpose)} 网关不支持 response_format，改为普通输出后解析 JSON`);
      data = await chatCompletion({ ...base, messages, toolChoice: false });
    }

    const text = contentToText(data.choices?.[0]?.message?.content).trim();
    const parsed = parseJsonLoose(text);
    const value = parsed === undefined ? null : validate(parsed);
    if (value !== null) return value;

    if (round < repairAttempts) {
      logger.warn('AI', `${logPrefix(base.purpose)} 输出不是合格的 JSON，要求重新生成`);
      messages.push({ role: 'assistant', content: text || '（空）' });
      messages.push({
        role: 'user',
        content:
          '你上一次的输出不是符合要求的 JSON。请严格按照前面说明的结构，只输出一个 JSON 对象，不要代码块、不要任何额外文字。',
      });
    }
  }

  throw new JsonOutputError('模型多次未返回符合要求的 JSON');
}

/** 测试专用：清空"不支持 response_format"的记忆 */
export function resetJsonModeCacheForTesting(): void {
  jsonModeUnsupported.clear();
}
