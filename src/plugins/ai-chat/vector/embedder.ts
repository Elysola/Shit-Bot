import { getAiConfig } from '@/plugins/ai-chat/config';
import { recordUsage } from '@/plugins/ai-chat/llm-client';

/** apiUrl 与 model 都填了才启用向量化（PLAN D5：不填就只用全文检索） */
export function embeddingEnabled(): boolean {
  const e = getAiConfig().embedding;
  return !!(e.apiUrl && e.model);
}

/** L2 归一化：之后余弦相似度就等于点积 */
export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

type EmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message?: string } | string;
};

async function post(url: string, body: unknown, apiKey: string, timeoutMs: number): Promise<EmbeddingResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`向量接口 HTTP ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as EmbeddingResponse;
    } catch (e) {
      const err = e as Error & { status?: number };
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      // 查询向量走回复路径，超时就不再重试，直接降级为全文检索
      if (!retryable || err.name === 'AbortError' || attempt >= 2) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 调用 OpenAI 兼容的 /embeddings：OpenAI、SiliconFlow、Gemini 兼容端点、Ollama、LM Studio、llama.cpp、TEI、vLLM 都适用。
 * kind 决定加 queryPrefix 还是 documentPrefix（非对称模型如 e5 / Qwen3-Embedding 需要）。返回归一化后的向量。
 */
export async function embedTexts(texts: string[], kind: 'query' | 'document', opts: { timeoutMs?: number } = {}): Promise<Float32Array[]> {
  const e = getAiConfig().embedding;
  if (!embeddingEnabled()) throw new Error('未配置向量模型');
  const url = `${e.apiUrl.replace(/\/+$/, '')}/embeddings`;
  const prefix = kind === 'query' ? e.queryPrefix : e.documentPrefix;
  const out: Float32Array[] = [];
  let dims = 0;
  for (let i = 0; i < texts.length; i += e.batchSize) {
    const batch = texts.slice(i, i + e.batchSize).map((t) => prefix + String(t ?? '').slice(0, 2000));
    const body: Record<string, unknown> = { model: e.model, input: batch, encoding_format: 'float' };
    if (e.dimensions > 0) body.dimensions = e.dimensions;
    const data = await post(url, body, e.apiKey, opts.timeoutMs ?? e.timeoutMs);
    const items = Array.isArray(data.data) ? [...data.data] : [];
    if (items.length !== batch.length) throw new Error(`向量接口返回 ${items.length} 条，期望 ${batch.length} 条`);
    items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const it of items) {
      const vec = it.embedding;
      if (!Array.isArray(vec) || vec.length === 0) throw new Error('向量接口返回了空向量');
      if (dims && vec.length !== dims) throw new Error(`向量维度不一致：${vec.length} ≠ ${dims}`);
      dims = vec.length;
      out.push(normalize(vec));
    }
    recordUsage('embed', e.model, { prompt_tokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0 });
  }
  return out;
}
