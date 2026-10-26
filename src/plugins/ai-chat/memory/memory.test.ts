import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '@/storage';
import { searchMemories, setVectorSearch } from './retrieve';
import { finalScore, fuseRelevance, queryTerms, rrfFuse } from './scoring';
import { forbiddenReason, looksSensitive } from './sensitive';
import {
  activeSlot,
  addMemory,
  countByKind,
  deleteMemoryChain,
  getMemory,
  listMemories,
  supersedeMemory,
  updateMemory,
  type NewMemory,
} from './store';
import { GUILD_ID, setupAiTest, snowflakeAt } from '@/testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';

function mem(content: string, extra: Partial<NewMemory> = {}): NewMemory {
  return { scope: 'user', subjectId: A, kind: 'fact', content, origin: 'extractor', ...extra };
}

beforeEach(() => setupAiTest({ memory: { enabled: true, core: { userPins: 2 } } }));
afterEach(() => setVectorSearch(null));

describe('store', () => {
  test('slot 新值取代旧值，旧值保留为历史并指向新值', () => {
    const old = addMemory(mem('住在北京', { slot: 'location', value: '北京' }));
    const neu = addMemory(mem('已经搬到上海', { slot: 'location', value: '上海' }));
    expect(activeSlot('user', A, 'location')?.id).toBe(neu.id);
    expect(getMemory(old.id)).toMatchObject({ status: 'superseded', superseded_by: neu.id });
    expect(listMemories({ scope: 'user', subjectId: A }).map((m) => m.id)).toEqual([neu.id]);
    expect(listMemories({ scope: 'user', subjectId: A, includeHistory: true })).toHaveLength(2);
  });

  test('重要度 ≥ 8 自动置顶；超出容量时把最不重要的降回档案', () => {
    const a = addMemory(mem('重要 9', { importance: 9 }));
    const b = addMemory(mem('重要 8', { importance: 8 }));
    expect([getMemory(a.id)?.pinned, getMemory(b.id)?.pinned]).toEqual([1, 1]);
    const c = addMemory(mem('重要 10', { importance: 10 }));
    expect(getMemory(c.id)?.pinned).toBe(1);
    expect(getMemory(b.id)?.pinned).toBe(0);
    expect(getMemory(a.id)?.pinned).toBe(1);
    // episode 与 relation 不自动置顶
    expect(addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'episode', content: '聊了游戏', importance: 9, origin: 'extractor' }).pinned).toBe(0);
  });

  test('非法类型、非法 slot、空内容会被拒绝', () => {
    expect(() => addMemory(mem('x', { kind: 'meme' }))).toThrow('不适用');
    expect(() => addMemory(mem('x', { slot: 'password' }))).toThrow('未知的 slot');
    expect(() => addMemory(mem('   '))).toThrow('为空');
  });

  test('修改内容会清掉向量标记；取代与按版本链删除', () => {
    const m = addMemory(mem('喜欢猫'));
    getDatabase().run("UPDATE memories SET embed_model = 'bge-m3' WHERE id = ?", [m.id]);
    expect(updateMemory(m.id, { content: '喜欢猫和狗' })).toBe(true);
    expect(getMemory(m.id)?.embed_model).toBeNull();
    const n = supersedeMemory(m.id, mem('只喜欢狗了'))!;
    expect(getMemory(m.id)?.status).toBe('superseded');
    expect(deleteMemoryChain(n.id)).toBe(2);
    expect(getMemory(m.id)).toBeNull();
  });

  test('按类型计数（记忆目录用），敏感记忆可选是否计入', () => {
    addMemory(mem('喜欢猫', { kind: 'preference' }));
    addMemory(mem('最近在吃药', { sensitive: true }));
    expect(countByKind('user', A, false)).toEqual([{ kind: 'preference', n: 1 }]);
    expect(countByKind('user', A, true).reduce((s, c) => s + c.n, 0)).toBe(2);
  });
});

describe('scoring', () => {
  test('queryTerms：中文长句切成三字片段 + 双字片段，并去掉常见虚词', () => {
    const t = queryTerms('她养了什么宠物');
    expect(t.fts).toContain('她养了什么宠物');
    expect(t.fts).toContain('什么宠');
    expect(t.like).toContain('宠物');
    expect(t.like).not.toContain('什么');
    expect(queryTerms('原神 深渊')).toEqual({ fts: [], like: ['原神', '深渊'] });
    expect(queryTerms('python async')).toEqual({ fts: ['python', 'async'], like: [] });
  });

  test('RRF 融合与最终分：相关度主导，过期计划降权', () => {
    const fused = rrfFuse([[1, 2], [2, 3]]);
    expect(fused.get(2)!).toBeGreaterThan(fused.get(1)!);
    expect(rrfFuse([[1], [2]], [1, 0.5]).get(1)!).toBeGreaterThan(rrfFuse([[1], [2]], [1, 0.5]).get(2)!);
    const now = Date.now();
    const base = { relevance: 1, importance: 5, updatedAt: now, accessCount: 0, kind: 'fact', validUntil: null, now };
    expect(finalScore(base)).toBeGreaterThan(finalScore({ ...base, relevance: 0.2 }));
    expect(finalScore({ ...base, kind: 'plan', validUntil: now - 1 })).toBeLessThan(finalScore(base) / 2);
  });

  test('有向量时语义相似度主导：字面碰巧重合的候选赢不过语义最相近的', () => {
    // 1 = 语义最相近但没有字面重合；2 = 语义第三但字面在两个通道都命中
    const lexical = new Map([[2, 0.03], [3, 0.01]]);
    const vector = new Map([[1, 0.62], [3, 0.55], [2, 0.5], [4, 0.35]]);
    const rel = fuseRelevance(lexical, vector);
    expect(rel.get(1)!).toBeGreaterThan(rel.get(2)!);
    // 没有向量时就是字面得分（归一化）
    expect(fuseRelevance(lexical, null).get(2)).toBe(1);
  });
});

describe('searchMemories', () => {
  beforeEach(() => {
    addMemory(mem('小红家里养了一只橘猫，名字叫豆豆', { subjectId: B, kind: 'preference' }));
    addMemory(mem('阿伟下周三要考英语六级', { kind: 'plan' }));
    addMemory(mem('阿伟最近在看心理医生', { sensitive: true }));
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'meme', content: '群里把迟到叫作"阿伟时间"', origin: 'extractor' });
  });

  test('中文自然语言问题也能命中（FTS 三字片段 + 双字 LIKE）', async () => {
    const r = await searchMemories({ query: '谁养了宠物猫', scopes: 'all-users', sensitiveFor: new Set(), limit: 5 });
    expect(r.items[0]?.row.content).toContain('豆豆');
    const r2 = await searchMemories({ query: '英语考试', scopes: [{ scope: 'user', subjectId: A }], sensitiveFor: new Set(), limit: 5 });
    expect(r2.items.map((i) => i.row.content)).toEqual(['阿伟下周三要考英语六级']);
  });

  test('作用域隔离 + 敏感记忆只对本人放行', async () => {
    const forOthers = await searchMemories({ query: '', scopes: [{ scope: 'user', subjectId: A }], sensitiveFor: new Set(), limit: 10 });
    expect(forOthers.items.map((i) => i.row.content)).toEqual(['阿伟下周三要考英语六级']);
    const forSelf = await searchMemories({ query: '心理医生', scopes: [{ scope: 'user', subjectId: A }], sensitiveFor: new Set([A]), limit: 10 });
    expect(forSelf.items).toHaveLength(1);
    const guild = await searchMemories({ query: '迟到', scopes: [{ scope: 'guild', subjectId: GUILD_ID }], sensitiveFor: new Set(), limit: 10 });
    expect(guild.items).toHaveLength(1);
  });

  test('everyone 限定为本服务器成员', async () => {
    getDatabase().run("INSERT INTO guild_members (guild_id, user_id, display_name, first_seen_at, last_seen_at) VALUES (?, ?, '小红', 0, 0)", [GUILD_ID, B]);
    const r = await searchMemories({ query: '', scopes: 'all-users', guildId: GUILD_ID, sensitiveFor: new Set(), limit: 10 });
    expect(r.items.map((i) => i.row.subject_id)).toEqual([B]);
  });

  test('向量通道的结果参与融合，但仍受作用域与敏感过滤', async () => {
    const target = addMemory(mem('周末喜欢去爬山', { kind: 'habit' }));
    const sensitive = getDatabase().query("SELECT id FROM memories WHERE content LIKE '%心理医生%'").get() as { id: number };
    setVectorSearch(async () => [{ id: sensitive.id, score: 0.9 }, { id: target.id, score: 0.8 }]);
    const r = await searchMemories({ query: '户外运动', scopes: [{ scope: 'user', subjectId: A }], sensitiveFor: new Set(), limit: 5 });
    expect(r.items.map((i) => i.row.id)).toEqual([target.id]);
  });

  test('检索到的记忆累加使用次数', async () => {
    await searchMemories({ query: '六级', scopes: [{ scope: 'user', subjectId: A }], sensitiveFor: new Set(), limit: 5 });
    const row = getDatabase().query("SELECT access_count FROM memories WHERE content LIKE '%六级%'").get() as { access_count: number };
    expect(row.access_count).toBe(1);
  });
});

describe('sensitive', () => {
  test('凭证与可定位个人的信息被拦下', () => {
    expect(forbiddenReason('我的密码是 hunter2abc')).toBe('密码/密钥');
    expect(forbiddenReason('key: sk-abcdefghijklmnopqrstuvwx')).toBe('API key');
    expect(forbiddenReason('手机 13812345678')).toBe('手机号');
    expect(forbiddenReason('身份证 11010519491231002X')).toBe('身份证号');
    // 前面写了 "ID" 也不能当成 Discord ID 放过（审查修复）
    expect(forbiddenReason('身份证ID 11010519491231002X')).toBe('身份证号');
    expect(forbiddenReason('他的 ID 100000000000000001')).toBeNull();
    expect(forbiddenReason('银行卡号 6222 0212 3456 7890 121')).toBeNull(); // Luhn 不通过
    expect(forbiddenReason('银行卡号 4111 1111 1111 1111')).toBe('银行卡号');
    expect(forbiddenReason('住在幸福路 88 号')).toBe('详细住址');
    expect(forbiddenReason('邮箱 a.b@example.com')).toBe('邮箱');
  });

  test('Discord ID 与普通数字不会被误判', () => {
    expect(forbiddenReason(`小明（ID ${snowflakeAt(Date.now())}）喜欢猫`)).toBeNull();
    expect(forbiddenReason(`<@${snowflakeAt(Date.now())}> 说他有 3 只猫`)).toBeNull();
    expect(forbiddenReason('考了 650 分，排名 12345')).toBeNull();
  });

  test('敏感话题识别', () => {
    expect(looksSensitive('最近确诊了焦虑症')).toBe(true);
    expect(looksSensitive('他是基督徒')).toBe(true);
    expect(looksSensitive('喜欢吃火锅')).toBe(false);
  });
});

describe('删除与画像（审查修复）', () => {
  test('删掉一条记忆后，从记忆写出来的画像随之失效（之后按剩下的记忆重新生成）', () => {
    const A = '100000000000000001';
    const m = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟在杭州工作', origin: 'extractor' });
    getDatabase().run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('user', ?, '阿伟在杭州工作', 0, 'm', ?)", [A, Date.now()]);
    deleteMemoryChain(m.id);
    expect(getDatabase().query("SELECT COUNT(*) AS c FROM profiles WHERE subject_id = ?").get(A)).toEqual({ c: 0 });
  });
});

describe('版本链删除（审查修复）', () => {
  test('同一个 slot 超过 200 个版本：/forget 一次全部删掉', () => {
    const A = '100000000000000001';
    let cur = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'location', value: '城市0', content: '住在城市0', origin: 'extractor' });
    for (let i = 1; i <= 205; i++) {
      cur = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'location', value: `城市${i}`, content: `住在城市${i}`, origin: 'extractor' });
    }
    expect(deleteMemoryChain(cur.id)).toBe(206);
    expect(getDatabase().query("SELECT COUNT(*) AS c FROM memories WHERE subject_id = ?").get(A)).toEqual({ c: 0 });
  });
});

describe('删除与反思特点（审查修复，第 6 轮）', () => {
  test('删掉一条记忆：未置顶的反思特点和画像一起失效，置顶的保留', () => {
    const A = '100000000000000001';
    const m = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟在杭州工作', origin: 'extractor' });
    const trait = addMemory({ scope: 'user', subjectId: A, kind: 'trait', content: '为工作在杭州打拼', origin: 'reflection' });
    const pinned = addMemory({ scope: 'user', subjectId: A, kind: 'trait', content: '嘴硬心软', origin: 'reflection', pinned: true });
    deleteMemoryChain(m.id);
    expect(getMemory(trait.id)).toBeNull();
    expect(getMemory(pinned.id)).not.toBeNull();
  });
});
