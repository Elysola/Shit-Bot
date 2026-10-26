import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as sqliteVec from 'sqlite-vec';
import { getConfig } from '../../config';
import { getDatabase } from '../../storage';
import { getMeta } from '../db/meta';
import { searchMemories } from '../memory/retrieve';
import { addMemory, deleteMemoryChain, updateMemory } from '../memory/store';
import { dot, hamming, toBinary } from './binary';
import { embedTexts, normalize } from './embedder';
import { embedPendingMemories, initVectors, memoryVectorSearch, resetVectorServiceForTesting, vectorStatus } from './service';
import { resetVectorStoreForTesting, searchVectors, setVectorBackend, upsertVector, type BackendKind } from './store';
import { GUILD_ID, setupAiTest } from '../../testing/fixtures';

const DIMS = 16;
const A = '100000000000000001';
const B = '100000000000000002';

/** 确定性的伪随机数（便于两个后端用同一份数据比较） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

function randomVec(r: () => number, dims = DIMS): Float32Array {
  return normalize(Array.from({ length: dims }, r));
}

function useBackend(kind: BackendKind): void {
  setVectorBackend(kind, kind === 'sqlite' ? sqliteVec.getLoadablePath() : null);
}

// 关键词 → 概念轴：一个极简的"语义"向量模型，用来测试没有字面重合时也能检索到
const CONCEPTS: Array<[RegExp, number]> = [
  [/猫|宠物|动物|豆豆/, 0],
  [/考试|六级|英语/, 1],
  [/上海|搬家|住/, 2],
  [/火锅|吃/, 3],
];
function fakeEmbedding(text: string): number[] {
  const v = Array(DIMS).fill(0.01);
  for (const [re, axis] of CONCEPTS) if (re.test(text)) v[axis] += 1;
  v[DIMS - 1] += (text.length % 7) * 0.001;
  return v;
}

const realFetch = globalThis.fetch;
let embedCalls: Array<{ model: string; input: string[]; dimensions?: number }> = [];

function installFakeEmbeddings(dims = DIMS): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; input: string[]; dimensions?: number };
    embedCalls.push(body);
    const data = body.input.map((t, index) => ({ index, embedding: fakeEmbedding(t).slice(0, dims).concat(Array(Math.max(0, dims - DIMS)).fill(0)) }));
    return new Response(JSON.stringify({ data, usage: { prompt_tokens: body.input.length * 5 } }), { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  setupAiTest({ embedding: { apiUrl: 'http://embed.test/v1', model: 'fake-embed', batchSize: 2 }, vector: { exactThreshold: 100, coarseK: 20 } });
  embedCalls = [];
  resetVectorStoreForTesting();
  resetVectorServiceForTesting();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetVectorStoreForTesting();
  resetVectorServiceForTesting();
});

describe('binary', () => {
  test('二值量化、汉明距离、点积', () => {
    const a = new Float32Array([0.5, -0.1, 0.2, -0.3, 0, 0.9, -0.2, 0.1, 0.4]);
    expect([...toBinary(a)]).toEqual([0b10100101, 0b00000001]);
    expect(hamming(toBinary(a), toBinary(a))).toBe(0);
    expect(hamming(new Uint8Array([0b1111]), new Uint8Array([0b0101]))).toBe(2);
    expect(dot(normalize([3, 4]), normalize([3, 4]))).toBeCloseTo(1, 6);
  });
});

describe('两个后端结果一致', () => {
  function seed(): Float32Array[] {
    const r = rng(42);
    // 5 个簇、每簇 60 条，分属 user 与 guild 两个分区
    const centers = Array.from({ length: 5 }, () => randomVec(r));
    const vecs: Float32Array[] = [];
    for (let i = 0; i < 300; i++) {
      const c = centers[i % 5];
      const v = normalize(Array.from(c, (x) => x + r() * 0.3));
      vecs.push(v);
      const scope = i % 3 === 0 ? 'guild' : 'user';
      const subject = scope === 'guild' ? GUILD_ID : `10000000000000${String(i % 20).padStart(4, '0')}`;
      upsertVector('memory', i + 1, `${scope}:${subject}`, scope === 'guild' ? `guild:${subject}` : 'user', 'm', v);
    }
    return vecs;
  }

  for (const path of ['exact', 'coarse'] as const) {
    test(`${path} 路径：sqlite 与 js 返回相同的 top-10`, () => {
      const results: Record<string, number[]> = {};
      for (const kind of ['sqlite', 'js'] as const) {
        setupAiTest({ embedding: { apiUrl: 'http://e/v1', model: 'm' } });
        useBackend(kind);
        const vecs = seed();
        const q = normalize(Array.from(vecs[7], (x, i) => x + (i % 2 ? 0.05 : -0.05)));
        results[kind] = searchVectors({
          query: q,
          model: 'm',
          where: { sql: "v.owner_type = 'memory' AND v.part = 'user'", params: [] },
          parts: ['user'],
          k: 10,
          exactThreshold: path === 'exact' ? 10_000 : 50,
          coarseK: 80,
        }).map((h) => h.ownerId);
      }
      expect(results.sqlite).toHaveLength(10);
      expect(results.js).toEqual(results.sqlite);
    });
  }

  test('粗筛只命中大分区里的少数几条时，退回精确计算保证召回', () => {
    useBackend('js');
    const vecs = seed();
    const subject = '100000000000000003';
    const hits = searchVectors({
      query: vecs[3],
      model: 'm',
      where: { sql: "v.owner_type = 'memory' AND v.scope_key = ?", params: [`user:${subject}`] },
      parts: ['user'],
      k: 5,
      exactThreshold: 1,
      coarseK: 3,
    });
    expect(hits.length).toBe(5);
  });
});

describe('embedder', () => {
  test('分批请求、加前缀、结果归一化；返回条数不对时报错', async () => {
    installFakeEmbeddings();
    getConfig().ai.embedding.queryPrefix = 'query: ';
    const vecs = await embedTexts(['猫', '考试', '火锅'], 'query');
    expect(embedCalls.map((c) => c.input)).toEqual([['query: 猫', 'query: 考试'], ['query: 火锅']]);
    expect(dot(vecs[0], vecs[0])).toBeCloseTo(1, 5);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(embedTexts(['x'], 'document')).rejects.toThrow('返回 0 条');
  });
});

describe('向量服务', () => {
  test('未配置向量模型时什么都不做', async () => {
    setupAiTest();
    await initVectors();
    expect(vectorStatus().enabled).toBe(false);
    expect(await memoryVectorSearch('猫', 'all-users', null, 5)).toEqual([]);
  });

  for (const kind of ['sqlite', 'js'] as const) {
    test(`${kind} 后端：回填、语义检索（没有字面重合也能命中）、内容变更后重算`, async () => {
      getConfig().ai.vector.backend = kind;
      installFakeEmbeddings();
      const cat = addMemory({ scope: 'user', subjectId: B, kind: 'preference', content: '小红家里养了一只橘猫，名字叫豆豆', origin: 'extractor' });
      addMemory({ scope: 'user', subjectId: A, kind: 'plan', content: '阿伟下周三要考英语六级', origin: 'extractor' });
      const hotpot = addMemory({ scope: 'user', subjectId: A, kind: 'preference', content: '最爱吃火锅', origin: 'extractor' });
      await initVectors();
      expect(vectorStatus()).toMatchObject({ enabled: true, backend: kind, pending: 3 });
      expect(await embedPendingMemories()).toBe(3);
      expect(vectorStatus()).toMatchObject({ embedded: 3, pending: 0, dims: DIMS });
      expect(getMeta('vector.backend')).toBe(kind);

      // "她养的动物"和"橘猫豆豆"没有任何相同的字，全文检索找不到，向量能找到
      const fts = await searchMemories({ query: '她养的动物', scopes: 'all-users', sensitiveFor: new Set(), limit: 3 });
      expect(fts.items[0]?.row.id).toBe(cat.id);
      expect((await memoryVectorSearch('她养的动物', 'all-users', null, 1))[0].id).toBe(cat.id);

      updateMemory(hotpot.id, { content: '最爱吃火锅，尤其是牛油锅' });
      expect(vectorStatus().pending).toBe(1);
      expect(await embedPendingMemories()).toBe(1);
    });
  }

  test('换了向量模型：清掉旧向量，全部重算', async () => {
    installFakeEmbeddings();
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '住在上海', origin: 'extractor' });
    await initVectors();
    await embedPendingMemories();
    expect(vectorStatus().embedded).toBe(1);
    getConfig().ai.embedding.model = 'another-model';
    await initVectors();
    expect(getMeta('embedding.model')).toBe('another-model');
    expect((getDatabase().query('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c).toBe(0);
    expect(vectorStatus().pending).toBe(1);
  });

  test('查询本服务器所有人时只看本服务器的成员', async () => {
    installFakeEmbeddings();
    getDatabase().run("INSERT INTO guild_members (guild_id, user_id, display_name, first_seen_at, last_seen_at) VALUES (?, ?, '阿伟', 0, 0)", [GUILD_ID, A]);
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟养了一只猫', origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: B, kind: 'fact', content: '小红也养猫', origin: 'extractor' });
    await initVectors();
    await embedPendingMemories();
    const ids = await memoryVectorSearch('宠物', 'all-users', GUILD_ID, 5);
    expect(ids).toHaveLength(1);
  });
});

describe('并发删除（审查修复）', () => {
  test('等向量服务返回期间记忆被删掉（/forget、/forget-me）：不会再写回向量', async () => {
    const m = addMemory({ scope: 'user', subjectId: '100000000000000001', kind: 'fact', content: '养了一只橘猫', origin: 'extractor' });
    installFakeEmbeddings();
    await initVectors();
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] };
      deleteMemoryChain(m.id);
      const data = body.input.map((t, index) => ({ index, embedding: fakeEmbedding(t) }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    await embedPendingMemories();
    expect(getDatabase().query('SELECT COUNT(*) AS c FROM vectors').get()).toEqual({ c: 0 });
  });
});

describe('关系记忆的向量候选（审查修复）', () => {
  test('查某个人时，无关的关系记忆不会先占满候选名额', async () => {
    const X = '100000000000000001';
    for (let i = 0; i < 45; i++) {
      addMemory({ scope: 'relation', subjectId: `1000000000000002${String(i).padStart(2, '0')}`, objectId: '100000000000000300', kind: 'relationship', content: '他们是同事', origin: 'extractor' });
    }
    const mine = addMemory({ scope: 'relation', subjectId: X, objectId: '100000000000000400', kind: 'relationship', content: '和小红是大学室友', origin: 'extractor' });
    installFakeEmbeddings();
    await initVectors();
    await embedPendingMemories();
    await embedPendingMemories();
    const hits = await memoryVectorSearch('他们是同事', [{ scope: 'relation', subjectId: X }], null, 40);
    expect(hits.map((h) => h.id)).toEqual([mine.id]);
  });
});

describe('查询向量缓存（审查修复）', () => {
  test('换了向量模型后不会用旧模型的查询向量', async () => {
    addMemory({ scope: 'user', subjectId: '100000000000000001', kind: 'fact', content: '养了一只橘猫', origin: 'extractor' });
    installFakeEmbeddings();
    await initVectors();
    await embedPendingMemories();
    await memoryVectorSearch('宠物', 'all-users', null, 5);
    const before = embedCalls.length;
    await memoryVectorSearch('宠物', 'all-users', null, 5);
    expect(embedCalls.length).toBe(before);
    getConfig().ai.embedding.model = 'fake-embed-2';
    await initVectors();
    await memoryVectorSearch('宠物', 'all-users', null, 5);
    expect(embedCalls.length).toBe(before + 1);
    expect((embedCalls[embedCalls.length - 1] as { model?: string }).model).toBe('fake-embed-2');
  });
});

describe('维度配置（审查修复）', () => {
  test('显式维度改回模型默认（dimensions: 0）也会清空重算', async () => {
    addMemory({ scope: 'user', subjectId: '100000000000000001', kind: 'fact', content: '养了一只橘猫', origin: 'extractor' });
    getConfig().ai.embedding.dimensions = 4;
    installFakeEmbeddings(4);
    await initVectors();
    await embedPendingMemories();
    expect(getDatabase().query('SELECT COUNT(*) AS c FROM vectors').get()).toEqual({ c: 1 });
    getConfig().ai.embedding.dimensions = 0;
    installFakeEmbeddings();
    await initVectors();
    expect(getDatabase().query('SELECT COUNT(*) AS c FROM vectors').get()).toEqual({ c: 0 });
  });
});
