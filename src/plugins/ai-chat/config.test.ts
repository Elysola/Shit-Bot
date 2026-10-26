import { afterEach, describe, expect, test } from 'bun:test';
import { setConfigForTesting } from '@/config';
import { getAiConfig, normalizeAiConfig } from './config';

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

describe('getAiConfig', () => {
  const plugin = (options: Record<string, unknown>, enabled = true): Record<string, unknown> => ({ plugins: [{ name: 'ai-chat', enabled, options }] });

  test('读 plugins[ai-chat].options；同一份配置返回同一个对象，换了配置重新规范化', () => {
    setConfigForTesting(plugin({ enabled: true, apiKey: 'k', model: 'm1' }));
    const a = getAiConfig();
    expect(a.model).toBe('m1');
    expect(getAiConfig()).toBe(a);
    setConfigForTesting(plugin({ enabled: true, apiKey: 'k', model: 'm2' }));
    expect(getAiConfig().model).toBe('m2');
  });

  test('插件配置没写时兼容旧的顶层 ai:；两处都有时以插件配置为准', () => {
    setConfigForTesting({ ai: { enabled: true, apiKey: 'k', model: 'legacy' } });
    expect(getAiConfig()).toMatchObject({ enabled: true, model: 'legacy' });
    setConfigForTesting({ ai: { enabled: true, apiKey: 'k', model: 'legacy' }, ...plugin({ enabled: true, apiKey: 'k', model: 'new' }) });
    expect(getAiConfig().model).toBe('new');
  });

  test('插件被 enabled: false 关掉、或没有 API Key 时视为未启用', () => {
    setConfigForTesting(plugin({ enabled: true, apiKey: 'k' }, false));
    expect(getAiConfig().enabled).toBe(false);
    setConfigForTesting(plugin({ enabled: true }));
    expect(getAiConfig().enabled).toBe(false);
    setConfigForTesting({});
    expect(getAiConfig().enabled).toBe(false);
  });

  test('ignoreEveryoneMention 默认 true', () => {
    expect(normalizeAiConfig({}).ignoreEveryoneMention).toBe(true);
    expect(normalizeAiConfig({ ignoreEveryoneMention: false }).ignoreEveryoneMention).toBe(false);
  });
});
