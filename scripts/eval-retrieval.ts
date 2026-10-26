/**
 * 检索评测（PLAN Phase 6.6）：需要一个真实的 OpenAI 兼容向量服务，手动运行，不进 CI。
 *
 *   EMBED_URL=http://127.0.0.1:11434/v1 EMBED_MODEL=bge-m3 bun run scripts/eval-retrieval.ts
 *
 * 输出三项：① 只用全文检索 vs 混合检索的 recall@5；② 二值粗筛 + 精确重排相对精确检索的 recall@10；
 * ③ sqlite-vec 与 JS 两个后端在真实向量上的结果是否一致。
 */
import * as sqliteVec from 'sqlite-vec';
import { setConfigForTesting } from '../src/config';
import { getDatabase, initDatabase } from '../src/storage';
import { migrateAiSchema } from '../src/plugins/ai-chat/db/schema';
import { searchMemories, setVectorSearch } from '../src/plugins/ai-chat/memory/retrieve';
import { addMemory, type MemoryRow } from '../src/plugins/ai-chat/memory/store';
import { embedTexts } from '../src/plugins/ai-chat/vector/embedder';
import { embedPendingMemories, initVectors, memoryVectorSearch } from '../src/plugins/ai-chat/vector/service';
import { searchVectors, setVectorBackend, upsertVector } from '../src/plugins/ai-chat/vector/store';

const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:11434/v1';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';

const PEOPLE = ['阿伟', '小红', '老王', '大白', '阿杰', '小雨', '豆包', '可乐'];

// [主体下标, 记忆内容]
const MEMORIES: Array<[number, string]> = [
  [0, '阿伟在杭州一家互联网公司做前端开发'],
  [0, '阿伟下周三要考英语六级，有点紧张'],
  [0, '阿伟最爱吃火锅，尤其是牛油锅底'],
  [0, '阿伟每天晚上都会去健身房练腿'],
  [0, '阿伟养了一只叫土豆的柯基'],
  [1, '小红家里养了一只橘猫，名字叫豆豆'],
  [1, '小红上个月从北京搬到了上海'],
  [1, '小红在读研究生，专业是生物医学'],
  [1, '小红喜欢看悬疑推理小说，最爱东野圭吾'],
  [1, '小红周末经常去爬山'],
  [2, '老王是群主，平时很少说话但很靠谱'],
  [2, '老王在玩原神，每周六晚上和大家一起打深渊'],
  [2, '老王的女儿今年刚上小学'],
  [2, '老王不吃香菜'],
  [2, '老王开了一家咖啡店'],
  [3, '大白是个夜猫子，凌晨三点还在线'],
  [3, '大白最近在学吉他，已经能弹简单的曲子'],
  [3, '大白对猫毛过敏'],
  [3, '大白在准备考公务员'],
  [3, '大白喜欢收集机械键盘'],
  [4, '阿杰是程序员，主要写 Go 和 Rust'],
  [4, '阿杰下个月要去日本旅游'],
  [4, '阿杰最近失恋了，心情不太好'],
  [4, '阿杰喜欢踢足球，是皇马球迷'],
  [4, '阿杰每天早上喝美式咖啡'],
  [5, '小雨是高中生，明年高考'],
  [5, '小雨喜欢画画，会在群里分享插画'],
  [5, '小雨养了两只仓鼠'],
  [5, '小雨在追一部韩剧'],
  [5, '小雨害怕打雷'],
  [6, '豆包是护士，经常上夜班'],
  [6, '豆包喜欢做烘焙，常做蛋糕'],
  [6, '豆包住在成都'],
  [6, '豆包在减肥，晚上不吃饭'],
  [6, '豆包的生日是 10 月 29 日'],
  [7, '可乐是大学生，学的是建筑'],
  [7, '可乐喜欢摄影，有一台富士相机'],
  [7, '可乐在玩 Minecraft，建了一座城堡'],
  [7, '可乐是左撇子'],
  [7, '可乐打算毕业后出国读研'],
];

// [问题, 期望命中的记忆内容（子串）]
const QUERIES: Array<[string, string]> = [
  ['谁养了宠物狗', '柯基'],
  ['她家的猫叫什么', '豆豆'],
  ['谁搬家了', '搬到了上海'],
  ['有人要考试吗', '六级'],
  ['谁会弹乐器', '吉他'],
  ['谁不能接触猫', '过敏'],
  ['谁在准备出国旅行', '日本旅游'],
  ['最近谁情绪低落', '失恋'],
  ['谁喜欢运动看球', '皇马'],
  ['谁快要参加高考了', '高考'],
  ['群里谁会画画', '插画'],
  ['谁在医院工作', '护士'],
  ['谁会做甜点', '烘焙'],
  ['谁在控制饮食', '减肥'],
  ['谁喜欢拍照', '摄影'],
  ['谁在开店做生意', '咖啡店'],
  ['谁熬夜最晚', '夜猫子'],
  ['谁写后端代码', 'Go 和 Rust'],
  ['谁喜欢读侦探故事', '东野圭吾'],
  ['谁讨厌某种调料', '香菜'],
];

function setup(): void {
  setConfigForTesting({
    twitter: { enabled: false },
    plugins: [
      {
        name: 'ai-chat',
        enabled: true,
        options: {
          enabled: true,
          apiKey: 'x',
          memory: { enabled: true },
          embedding: { apiUrl: EMBED_URL, apiKey: 'ollama', model: EMBED_MODEL, batchSize: 16, timeoutMs: 120000 },
          vector: { backend: 'auto' },
        },
      },
    ],
  });
  initDatabase(':memory:');
  // AI 表由插件在启动时迁移；评测直接建
  migrateAiSchema(getDatabase(), { quiet: true });
}

async function recallAt5(label: string, ids: Map<string, number>): Promise<number> {
  let hit = 0;
  const misses: string[] = [];
  for (const [q, expect] of QUERIES) {
    const r = await searchMemories({ query: q, scopes: 'all-users', sensitiveFor: new Set(), limit: 5 });
    const want = ids.get(expect)!;
    if (r.items.some((i) => i.row.id === want)) hit++;
    else misses.push(q);
  }
  console.log(`${label}: recall@5 = ${hit}/${QUERIES.length} = ${(hit / QUERIES.length).toFixed(2)}${misses.length ? `；未命中：${misses.join('、')}` : ''}`);
  return hit / QUERIES.length;
}

async function main(): Promise<void> {
  console.log(`向量服务：${EMBED_URL}（${EMBED_MODEL}）\n`);
  setup();
  const ids = new Map<string, number>();
  const rows: MemoryRow[] = [];
  for (const [p, content] of MEMORIES) {
    const subject = `1000000000000000${String(p).padStart(2, '0')}`;
    const row = addMemory({ scope: 'user', subjectId: subject, kind: 'fact', content, origin: 'extractor' });
    rows.push(row);
    for (const [, exp] of QUERIES) if (content.includes(exp)) ids.set(exp, row.id);
  }

  // ① 全文检索 vs 混合检索
  setVectorSearch(null);
  const fts = await recallAt5('只用全文检索', ids);
  await initVectors();
  let t = performance.now();
  while ((await embedPendingMemories()) > 0) {
    // 回填全部记忆
  }
  console.log(`（回填 ${rows.length} 条记忆耗时 ${((performance.now() - t) / 1000).toFixed(1)}s）`);
  const hybrid = await recallAt5('混合检索（FTS + 向量）', ids);
  let vecHit = 0;
  for (const [q, expect] of QUERIES) if ((await memoryVectorSearch(q, 'all-users', null, 5)).some((h) => h.id === ids.get(expect))) vecHit++;
  console.log(`只用向量：recall@5 = ${vecHit}/${QUERIES.length}`);

  // ② 二值粗筛 + 精确重排 vs 精确：用真实向量造一个 400 条的集合
  const templates = ['{p}今天{t}', '{p}说他最近在{t}', '听说{p}很喜欢{t}', '{p}周末打算{t}'];
  const topics = ['打篮球', '学日语', '做饭', '看电影', '写代码', '弹钢琴', '跑步', '画画', '玩游戏', '养花'];
  const texts: string[] = [];
  for (const tp of templates) for (const p of PEOPLE) for (const tc of topics) texts.push(tp.replace('{p}', p).replace('{t}', tc));
  t = performance.now();
  const vecs = await embedTexts(texts.slice(0, 320), 'document');
  console.log(`\n（为粗筛评测向量化 ${vecs.length} 条耗时 ${((performance.now() - t) / 1000).toFixed(1)}s）`);
  const queries = await embedTexts(['谁喜欢运动', '谁在学外语', '谁会乐器', '谁喜欢下厨', '周末有什么安排'], 'query');

  const results: Record<string, number[][]> = {};
  for (const kind of ['sqlite', 'js'] as const) {
    setup();
    setVectorBackend(kind, kind === 'sqlite' ? sqliteVec.getLoadablePath() : null);
    vecs.forEach((v, i) => upsertVector('memory', i + 1, 'user:x', 'user', 'm', v));
    const where = { sql: "v.owner_type = 'memory'", params: [] };
    let overlap = 0;
    results[kind] = [];
    for (const q of queries) {
      const exact = searchVectors({ query: q, model: 'm', where, parts: ['user'], k: 10, exactThreshold: 1_000_000, coarseK: 0 }).map((h) => h.ownerId);
      const coarse = searchVectors({ query: q, model: 'm', where, parts: ['user'], k: 10, exactThreshold: 10, coarseK: 80 }).map((h) => h.ownerId);
      overlap += coarse.filter((x) => exact.includes(x)).length;
      results[kind].push(exact);
    }
    console.log(`${kind} 后端：二值粗筛 80 → 精确重排的 recall@10 = ${(overlap / (queries.length * 10)).toFixed(2)}`);
  }
  const same = results.sqlite.every((r, i) => JSON.stringify(r) === JSON.stringify(results.js[i]));
  console.log(`\n两个后端在真实向量上的精确检索结果一致：${same ? '是' : '否'}`);
  console.log(`\n结论：混合检索 ${hybrid >= fts ? '不低于' : '低于'} 只用全文检索（${hybrid.toFixed(2)} vs ${fts.toFixed(2)}）`);
}

main().catch((e) => {
  console.error('评测失败:', e);
  process.exit(1);
});
