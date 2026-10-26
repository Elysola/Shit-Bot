import { getConfig } from '../config';
import { getDatabase } from '../storage';
import { isAiSchemaReady } from './db/schema';
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
  const ai = getConfig().ai;
  return { apiUrl: ai.apiUrl, apiKey: ai.apiKey, model: ai.model };
}

/** 后台抽取/评估/画像所用的调用目标：extractor 的各项留空时沿用聊天配置 */
export function extractorTarget(): LlmTarget {
  const ai = getConfig().ai;
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
  return { ...ex, model: getConfig().ai.proactive.judgeModel || ex.model };
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      return data;
    } catch (e) {
      const err = e as LlmHttpError;
      const status = err.status || 0;
      const isTimeout = err.name === 'AbortError';
      const retryable =
        (!status || isTimeout || status === 408 || status === 429 || status >= 500) && !isImageFetchError(err);
      const attemptCap = isTimeout ? Math.min(2, maxAttempts) : maxAttempts;
      if (!retryable || attempt >= attemptCap) throw e;
      lastErr = e;
      const wait = Math.min(err.retryAfterMs ?? retryBaseMs * attempt, 10000);
      const reason = isTimeout ? '请求超时' : err.message;
      console.warn(`${logPrefix(req.purpose)} 瞬时错误，${wait}ms 后重试 ${attempt}/${attemptCap - 1}: ${reason}`);
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
    console.warn('[AI] 记录 token 用量失败(忽略):', (e as Error).message);
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
      console.warn(`${logPrefix(base.purpose)} 网关不支持 response_format，改为普通输出后解析 JSON`);
      data = await chatCompletion({ ...base, messages, toolChoice: false });
    }

    const text = contentToText(data.choices?.[0]?.message?.content).trim();
    const parsed = parseJsonLoose(text);
    const value = parsed === undefined ? null : validate(parsed);
    if (value !== null) return value;

    if (round < repairAttempts) {
      console.warn(`${logPrefix(base.purpose)} 输出不是合格的 JSON，要求重新生成`);
      messages.push({ role: 'assistant', content: text || '（空）' });
      messages.push({
        role: 'user',
        content:
          '你上一次的输出不是符合要求的 JSON。请严格按照前面说明的结构，只输出一个 JSON 对象，不要代码块、不要任何额外文字。',
      });
    }
  }

  throw new Error('模型多次未返回符合要求的 JSON');
}

/** 测试专用：清空"不支持 response_format"的记忆 */
export function resetJsonModeCacheForTesting(): void {
  jsonModeUnsupported.clear();
}
