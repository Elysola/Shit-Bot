import { afterEach, describe, expect, test } from 'bun:test';
import { normalizeAiConfig, setConfigForTesting } from './config';
import { deepMerge } from './web/server';

describe('normalizeAiConfig', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test('空配置得到完整默认值', () => {
    const ai = normalizeAiConfig(undefined);
    expect(ai.enabled).toBe(false);
    expect(ai.persona).toEqual({ dir: 'data/personas', default: 'memecat', guilds: {} });
    expect(ai.memory.extractor.windowMessages).toBe(40);
    expect(ai.memory.context.autoRecall).toBe(0);
    expect(ai.embedding.apiUrl).toBe('');
    expect(ai.vector.backend).toBe('auto');
    expect(ai.proactive.enabled).toBe(true);
    expect(ai.proactive.quietHours).toBe('');
    expect(ai.mood.valenceHalfLifeHours).toBe(3);
  });

  test('非法数值被钳到合法区间，非法枚举回退默认', () => {
    const ai = normalizeAiConfig({
      memory: { extractor: { windowMessages: -5, concurrency: 99 }, context: { autoRecall: 'abc' } },
      vector: { backend: 'faiss', coarseK: 1e9 },
      proactive: { quietHours: '25:00-08:00', threshold: -1 },
      mood: { valenceHalfLifeHours: 0 },
    });
    expect(ai.memory.extractor.windowMessages).toBe(5);
    expect(ai.memory.extractor.concurrency).toBe(4);
    expect(ai.memory.context.autoRecall).toBe(0);
    expect(ai.vector.backend).toBe('auto');
    expect(ai.vector.coarseK).toBe(5000);
    expect(ai.proactive.quietHours).toBe('');
    expect(ai.proactive.threshold).toBe(0);
    expect(ai.mood.valenceHalfLifeHours).toBe(0.1);
  });

  test('保留合法值；前缀字符串不 trim；URL/模型名会 trim', () => {
    const ai = normalizeAiConfig({
      embedding: { apiUrl: ' http://127.0.0.1:11434/v1 ', model: ' bge-m3 ', queryPrefix: 'query: ' },
      persona: { guilds: { '123': ' memecat ', bad: 42 } },
      proactive: { quietHours: '02:00-08:00', channels: [' 1 ', '', 2] },
    });
    expect(ai.embedding.apiUrl).toBe('http://127.0.0.1:11434/v1');
    expect(ai.embedding.model).toBe('bge-m3');
    expect(ai.embedding.queryPrefix).toBe('query: ');
    expect(ai.persona.guilds).toEqual({ '123': 'memecat' });
    expect(ai.proactive.quietHours).toBe('02:00-08:00');
    expect(ai.proactive.channels).toEqual(['1', '2']);
  });

  test('幂等：对规范化结果再规范化一次不变', () => {
    const once = normalizeAiConfig({ enabled: true, apiKey: 'k', memory: { enabled: true, core: { userPins: 3 } } });
    expect(normalizeAiConfig(once)).toEqual(once);
  });

  test('环境变量覆盖密钥', () => {
    process.env.AI_EMBEDDING_API_KEY = 'env-embed';
    process.env.AI_EXTRACTOR_API_KEY = 'env-extract';
    const ai = normalizeAiConfig({ embedding: { apiKey: 'file' }, memory: { extractor: { apiKey: 'file' } } });
    expect(ai.embedding.apiKey).toBe('env-embed');
    expect(ai.memory.extractor.apiKey).toBe('env-extract');
  });
});

describe('setConfigForTesting', () => {
  test('补齐 discord.privilegedIntents', () => {
    const cfg = setConfigForTesting({ discord: { enabled: false, privilegedIntents: { members: 'on', presences: 'nope' } } });
    expect(cfg.discord.privilegedIntents).toEqual({ members: 'on', presences: 'auto' });
  });
});

describe('deepMerge', () => {
  test('嵌套对象递归合并，数组整体替换', () => {
    const base = { a: 1, nested: { x: 1, y: 2, list: [1, 2] }, keep: { z: 1 } };
    const merged: Record<string, unknown> = deepMerge(base, { nested: { y: 3, list: [9] }, extra: true });
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 3, list: [9] }, keep: { z: 1 }, extra: true });
    expect(base.nested.y).toBe(2);
  });

  test('部分嵌套字段 + 规范化后不会丢默认值', () => {
    const prev = normalizeAiConfig({ memory: { enabled: true } });
    const merged = normalizeAiConfig(deepMerge(prev, { memory: { extractor: { model: 'cheap-model' } } }));
    expect(merged.memory.enabled).toBe(true);
    expect(merged.memory.extractor.model).toBe('cheap-model');
    expect(merged.memory.extractor.windowMessages).toBe(40);
    expect(merged.memory.context.speakerChars).toBe(1200);
  });
});
