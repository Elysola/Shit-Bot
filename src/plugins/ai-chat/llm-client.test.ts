import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setConfigForTesting } from '@/config';
import { getDatabase, initDatabase } from '@/storage';
import { migrateAiSchema } from './db/schema';
import {
  chatCompletion,
  extractorTarget,
  getTokensUsedToday,
  jsonCompletion,
  judgeTarget,
  parseJsonLoose,
  resetJsonModeCacheForTesting,
  type ChatRequest,
} from './llm-client';

type Call = { url: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** 依次返回给定的响应；每个元素是 [status, body] */
function scriptFetch(responses: Array<[number, unknown]>): void {
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const [status, body] = responses[Math.min(i++, responses.length - 1)];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

function okReply(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): unknown {
  return { choices: [{ message: { content }, finish_reason: 'stop' }], usage };
}

const target = { apiUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm1' };
const baseReq: ChatRequest = {
  target,
  purpose: 'extract',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  retryBaseMs: 1,
};

beforeEach(() => {
  calls = [];
  initDatabase(':memory:');
  migrateAiSchema(getDatabase(), { quiet: true });
  resetJsonModeCacheForTesting();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('chatCompletion', () => {
  test('5xx 会重试，成功后按用途记录 token', async () => {
    scriptFetch([
      [502, 'bad gateway'],
      [200, okReply('ok')],
    ]);
    const res = await chatCompletion(baseReq);
    expect(res.choices?.[0]?.message?.content).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://llm.test/v1/chat/completions');
    const row = getDatabase().query('SELECT purpose, model, calls, prompt_tokens, completion_tokens FROM llm_usage').get();
    expect(row).toEqual({ purpose: 'extract', model: 'm1', calls: 1, prompt_tokens: 10, completion_tokens: 5 });
    expect(getTokensUsedToday(['extract'])).toBe(15);
    expect(getTokensUsedToday(['chat'])).toBe(0);
  });

  test('400 不重试，错误带 status 与 body', async () => {
    scriptFetch([[400, 'bad request']]);
    const err = (await chatCompletion(baseReq).catch((e) => e)) as Error & { status?: number; body?: string };
    expect(err.status).toBe(400);
    expect(err.body).toBe('bad request');
    expect(calls).toHaveLength(1);
  });

  test('上游拉图失败即使是 5xx 也不重试', async () => {
    scriptFetch([[500, 'failed to download image']]);
    await expect(chatCompletion(baseReq)).rejects.toThrow('failed to download');
    expect(calls).toHaveLength(1);
  });

  test('超过最大次数后抛出最后的错误', async () => {
    scriptFetch([[503, 'busy']]);
    await expect(chatCompletion(baseReq)).rejects.toThrow('HTTP 503');
    expect(calls).toHaveLength(3);
  });

  test('toolChoice=false 时不附带 tools；默认附带并为 auto', async () => {
    const tool = { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } };
    scriptFetch([[200, okReply('a')]]);
    await chatCompletion({ ...baseReq, tools: [tool], toolChoice: false });
    expect(calls[0].body.tools).toBeUndefined();
    await chatCompletion({ ...baseReq, tools: [tool] });
    expect(calls[1].body.tool_choice).toBe('auto');
    expect(calls[1].body.tools).toHaveLength(1);
  });
});

describe('jsonCompletion', () => {
  const isObjWithN = (v: unknown): { n: number } | null =>
    v && typeof v === 'object' && typeof (v as { n?: unknown }).n === 'number' ? (v as { n: number }) : null;

  test('默认请求 json_object，并能解析代码块包裹的 JSON', async () => {
    scriptFetch([[200, okReply('```json\n{"n": 1}\n```')]]);
    const v = await jsonCompletion({ ...baseReq, validate: isObjWithN });
    expect(v).toEqual({ n: 1 });
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
  });

  test('网关拒绝 response_format 时降级，并记住不再发送', async () => {
    scriptFetch([
      [400, 'Unknown parameter: response_format'],
      [200, okReply('{"n": 2}')],
      [200, okReply('{"n": 3}')],
    ]);
    expect(await jsonCompletion({ ...baseReq, validate: isObjWithN })).toEqual({ n: 2 });
    expect(calls[1].body.response_format).toBeUndefined();
    expect(await jsonCompletion({ ...baseReq, validate: isObjWithN })).toEqual({ n: 3 });
    expect(calls[2].body.response_format).toBeUndefined();
  });

  test('第一次不合格会带纠错提示重试', async () => {
    scriptFetch([
      [200, okReply('抱歉，我不能')],
      [200, okReply('{"n": 4}')],
    ]);
    expect(await jsonCompletion({ ...baseReq, validate: isObjWithN })).toEqual({ n: 4 });
    const msgs = calls[1].body.messages as Array<{ role: string; content: string }>;
    expect(msgs[msgs.length - 1].role).toBe('user');
    expect(msgs[msgs.length - 1].content).toContain('不是符合要求的 JSON');
  });

  test('多次不合格则抛错', async () => {
    scriptFetch([[200, okReply('{"x": 1}')]]);
    await expect(jsonCompletion({ ...baseReq, validate: isObjWithN })).rejects.toThrow('JSON');
    expect(calls).toHaveLength(2);
  });
});

describe('parseJsonLoose', () => {
  test('各种包裹形式', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('结果如下：{"a":2} 以上')).toEqual({ a: 2 });
    expect(parseJsonLoose('```\n{"a":3}\n```')).toEqual({ a: 3 });
    expect(parseJsonLoose('没有 JSON')).toBeUndefined();
    expect(parseJsonLoose('')).toBeUndefined();
  });
});

describe('调用目标', () => {
  test('extractor 留空时沿用聊天配置；judgeModel 覆盖模型', () => {
    setConfigForTesting({ plugins: [{ name: 'ai-chat', enabled: true, options: { apiUrl: 'http://chat/v1', apiKey: 'ck', model: 'chat-m', memory: { extractor: { model: 'cheap' } } } }] });
    expect(extractorTarget()).toEqual({ apiUrl: 'http://chat/v1', apiKey: 'ck', model: 'cheap' });
    expect(judgeTarget().model).toBe('cheap');
    setConfigForTesting({ plugins: [{ name: 'ai-chat', enabled: true, options: { apiUrl: 'http://chat/v1', apiKey: 'ck', model: 'chat-m', proactive: { judgeModel: 'judge' } } }] });
    expect(extractorTarget().model).toBe('chat-m');
    expect(judgeTarget().model).toBe('judge');
  });
});
