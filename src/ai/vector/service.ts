import { Database } from 'bun:sqlite';
import { getConfig } from '../../config';
import { getDatabase } from '../../storage';
import { deleteMeta, getMeta, setMeta } from '../db/meta';
import { isAiSchemaReady } from '../db/schema';
import { setVectorSearch, type ScopeRef } from '../memory/retrieve';
import { SLOT_LABEL, type MemoryScope } from '../memory/store';
import { PRIORITY, enqueueJob, registerJobHandler, registerScheduler } from '../worker';
import { embedTexts, embeddingEnabled } from './embedder';
import {
  binIndexCount,
  dropBinIndexes,
  ensureBinIndex,
  pruneBinIndex,
  rebuildBinIndex,
  searchVectors,
  setVectorBackend,
  upsertVector,
  vectorBackend,
  type BackendKind,
} from './store';

const EMBED_BATCH = 64;
const QUERY_TIMEOUT_MS = 3000;
const QUERY_CACHE_MAX = 200;
const queryCache = new Map<string, Float32Array>();

let initialized = false;

export function memoryScopeKey(scope: MemoryScope, subjectId: string): string {
  return `${scope}:${subjectId}`;
}

/** 粗筛分区：服务器记忆按服务器分开（量大、查询总是带服务器），其它按作用域类型 */
export function memoryPart(scope: MemoryScope, subjectId: string): string {
  return scope === 'guild' ? `guild:${subjectId}` : scope;
}

/** macOS 自带的 SQLite 禁止加载扩展：配置了 customSqlitePath 时必须在打开第一个数据库之前切换 */
export function configureSqliteRuntime(): void {
  const p = getConfig().ai.vector.customSqlitePath;
  if (!p || process.platform !== 'darwin') return;
  try {
    Database.setCustomSQLite(p);
    console.log(`[Vector] 使用自定义 SQLite: ${p}`);
  } catch (e) {
    console.warn('[Vector] 设置自定义 SQLite 失败:', (e as Error).message);
  }
}

/** 尝试加载 sqlite-vec：先用配置的 extensionPath，否则用 npm 包自带的二进制；成功返回扩展路径 */
async function tryLoadSqliteVec(db: Database): Promise<string | null> {
  const configured = getConfig().ai.vector.extensionPath;
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  else {
    try {
      const mod = (await import('sqlite-vec')) as { getLoadablePath: () => string };
      candidates.push(mod.getLoadablePath());
    } catch (e) {
      console.warn('[Vector] 找不到 sqlite-vec 扩展包:', (e as Error).message);
    }
  }
  for (const path of candidates) {
    try {
      db.loadExtension(path);
      const v = (db.query('SELECT vec_version() AS v').get() as { v: string }).v;
      console.log(`[Vector] sqlite-vec ${v} 已加载`);
      return path;
    } catch (e) {
      console.warn(`[Vector] 加载 sqlite-vec 失败 (${path}):`, (e as Error).message);
    }
  }
  return null;
}

/** 当前向量模型与维度；维度未知（还没算过任何向量）时为 null */
function currentModel(): { model: string; dims: number | null } {
  const dims = Number(getMeta('embedding.dims'));
  return { model: getConfig().ai.embedding.model, dims: Number.isFinite(dims) && dims > 0 ? dims : null };
}

/** 换模型 / 换维度：清掉旧向量与索引，全部记忆标记为待重算（后台重新计算） */
function resetForNewModel(model: string, reason: string): void {
  const db = getDatabase();
  const n = (db.query('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c;
  dropBinIndexes();
  db.run('DELETE FROM vectors');
  db.run('UPDATE memories SET embed_model = NULL WHERE embed_model IS NOT NULL');
  deleteMeta('embedding.dims');
  setMeta('embedding.model', model);
  queryCache.clear();
  console.log(`[Vector] ${reason}：清除 ${n} 条旧向量，后台将重新计算`);
}

/**
 * 启动时调用：决定后端（sqlite / js）、检测模型变化、校验二值索引、注册向量检索通道。
 * 没配向量模型时什么都不做（检索只用全文检索）。
 */
export async function initVectors(): Promise<void> {
  setVectorSearch(null);
  initialized = false;
  queryCache.clear();
  if (!isAiSchemaReady() || !embeddingEnabled()) {
    if (isAiSchemaReady()) console.log('[Vector] 未配置向量模型，记忆检索只用全文检索');
    return;
  }
  const cfg = getConfig().ai;
  const db = getDatabase();
  let kind: BackendKind = 'js';
  let path: string | null = null;
  if (cfg.vector.backend !== 'js') {
    path = await tryLoadSqliteVec(db);
    if (path) kind = 'sqlite';
    else if (cfg.vector.backend === 'sqlite') console.warn('[Vector] 配置要求 sqlite 后端但扩展加载失败，改用 js 后端');
  }
  // 扩展已在当前连接上加载过，store 只需在连接被替换后重新加载
  setVectorBackend(kind, path, kind === 'sqlite');

  const { model } = currentModel();
  const prevModel = getMeta('embedding.model');
  if (prevModel && prevModel !== model) resetForNewModel(model, `向量模型从 ${prevModel} 换成了 ${model}`);
  else if (!prevModel) setMeta('embedding.model', model);
  const { dims } = currentModel();
  // 记下请求的维度配置（0 = 模型默认）：显式维度改回默认、或者反过来，都要清空重算——光看实际维度发现不了"改回默认"
  const requested = String(cfg.embedding.dimensions);
  const prevRequested = getMeta('embedding.requested_dims');
  if (prevRequested !== null && prevRequested !== requested) {
    resetForNewModel(model, `向量维度配置从 ${prevRequested === '0' ? '模型默认' : prevRequested} 改成了 ${requested === '0' ? '模型默认' : requested}`);
  } else if (dims && cfg.embedding.dimensions > 0 && cfg.embedding.dimensions !== dims) {
    resetForNewModel(model, `向量维度从 ${dims} 改成了 ${cfg.embedding.dimensions}`);
  }
  setMeta('embedding.requested_dims', requested);

  if (kind === 'sqlite' && dims && ensureBinIndex(dims)) {
    const total = (db.query('SELECT COUNT(*) AS c FROM vectors WHERE model = ? AND dims = ?').get(model, dims) as { c: number }).c;
    // 上次用的是 js 后端：期间重算过的向量不会同步到二值索引，条数对得上也可能是旧码，一律重建
    const fromJs = getMeta('vector.backend') === 'js';
    if (fromJs || binIndexCount(dims) !== total) console.log(`[Vector] 二值索引已重建（${rebuildBinIndex(model, dims)} 条）`);
  }

  setMeta('vector.backend', kind);
  setVectorSearch(memoryVectorSearch);
  initialized = true;
  const pending = pendingCount();
  console.log(`[Vector] 后端：${kind === 'sqlite' ? 'sqlite-vec（数据库内计算）' : 'JS'}；模型 ${model}${dims ? `（${dims} 维）` : ''}；待向量化记忆 ${pending} 条`);
}

export function vectorsReady(): boolean {
  return initialized && embeddingEnabled();
}

function pendingCount(): number {
  return (
    getDatabase()
      .query("SELECT COUNT(*) AS c FROM memories WHERE status = 'active' AND (embed_model IS NULL OR embed_model != ?)")
      .get(getConfig().ai.embedding.model) as { c: number }
  ).c;
}

/** 参与向量化的文本：slot 带上属性名，便于"TA 住哪"这类问题命中 */
function embeddingText(r: { slot: string | null; value: string | null; content: string }): string {
  const slot = r.slot ? `${SLOT_LABEL[r.slot] ?? r.slot}：${r.value ?? ''} ` : '';
  return `${slot}${r.content}`;
}

/** 回填 / 增量向量化：每次最多 limit 条；同时清理已被取代、已删除记忆的向量。返回本次处理的条数 */
export async function embedPendingMemories(limit: number = EMBED_BATCH): Promise<number> {
  if (!vectorsReady()) return 0;
  const db = getDatabase();
  const model = getConfig().ai.embedding.model;
  db.run("DELETE FROM vectors WHERE owner_type = 'memory' AND owner_id NOT IN (SELECT id FROM memories WHERE status = 'active')");
  const rows = db
    .query(
      `SELECT id, scope, subject_id, slot, value, content FROM memories
       WHERE status = 'active' AND (embed_model IS NULL OR embed_model != ?) ORDER BY importance DESC, updated_at DESC LIMIT ?`
    )
    .all(model, limit) as Array<{ id: number; scope: MemoryScope; subject_id: string; slot: string | null; value: string | null; content: string }>;
  if (rows.length === 0) return 0;

  const vecs = await embedTexts(rows.map(embeddingText), 'document');
  const dims = vecs[0].length;
  const known = currentModel().dims;
  if (known && known !== dims) {
    resetForNewModel(model, `向量维度变成了 ${dims}（之前是 ${known}）`);
    return 0;
  }
  if (!known) setMeta('embedding.dims', String(dims));

  const now = Date.now();
  const stillSame = db.prepare("SELECT 1 FROM memories WHERE id = ? AND status = 'active' AND content = ?");
  db.transaction(() => {
    rows.forEach((r, i) => {
      // 等向量服务期间记忆被删除（/forget、/forget-me）或内容被改过：不写，下一轮按新内容重算
      if (!stillSame.get(r.id, r.content)) return;
      upsertVector('memory', r.id, memoryScopeKey(r.scope, r.subject_id), memoryPart(r.scope, r.subject_id), model, vecs[i], now);
      db.run('UPDATE memories SET embed_model = ? WHERE id = ?', [model, r.id]);
    });
  })();
  pruneBinIndex(dims);
  return rows.length;
}

function whereForScopes(scopes: ScopeRef[] | 'all-users', guildId: string | null): { where: { sql: string; params: Array<string | number> }; parts: string[] } {
  const base = "v.owner_type = 'memory'";
  if (scopes === 'all-users') {
    if (guildId) {
      return {
        where: { sql: `${base} AND v.part = 'user' AND v.scope_key IN (SELECT 'user:' || user_id FROM guild_members WHERE guild_id = ?)`, params: [guildId] },
        parts: ['user'],
      };
    }
    return { where: { sql: `${base} AND v.part = 'user'`, params: [] }, parts: ['user'] };
  }
  const keys: string[] = [];
  const parts = new Set<string>();
  const relationOf: string[] = [];
  for (const s of scopes) {
    if (s.scope === 'relation') relationOf.push(s.subjectId);
    else keys.push(memoryScopeKey(s.scope, s.subjectId));
    parts.add(memoryPart(s.scope, s.subjectId));
  }
  const ors: string[] = [];
  const params: Array<string | number> = [...keys];
  if (keys.length) ors.push(`v.scope_key IN (${keys.map(() => '?').join(',')})`);
  // 关系记忆的向量按甲方存，查乙方时也要能找到：在截取前就按记忆的两端限定到这个人，
  // 否则一大批无关的关系记忆会先占满候选名额，被记忆层过滤掉后什么都不剩
  if (relationOf.length) {
    const marks = relationOf.map(() => '?').join(',');
    ors.push(
      `(v.part = 'relation' AND v.owner_id IN (SELECT id FROM memories WHERE scope = 'relation' AND (subject_id IN (${marks}) OR object_id IN (${marks}))))`
    );
    params.push(...relationOf, ...relationOf);
  }
  return { where: { sql: `${base} AND (${ors.join(' OR ') || '0'})`, params }, parts: [...parts] };
}

async function queryVector(query: string): Promise<Float32Array> {
  // 键里带上模型配置：换了模型 / 端点 / 维度 / 前缀后，旧模型算的查询向量不能拿来和新模型的文档向量比
  const e = getConfig().ai.embedding;
  const text = query.trim().slice(0, 500);
  const key = `${e.apiUrl}|${e.model}|${e.dimensions}|${e.queryPrefix}|${text}`;
  const cached = queryCache.get(key);
  if (cached) return cached;
  const [vec] = await embedTexts([text], 'query', { timeoutMs: QUERY_TIMEOUT_MS });
  queryCache.set(key, vec);
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string);
  return vec;
}

/** 记忆检索的向量通道（注册到 retrieve.setVectorSearch）：返回按相似度排序的记忆 id 与余弦相似度 */
export async function memoryVectorSearch(
  query: string,
  scopes: ScopeRef[] | 'all-users',
  guildId: string | null,
  limit: number
): Promise<Array<{ id: number; score: number }>> {
  if (!vectorsReady() || !query.trim()) return [];
  const vec = await queryVector(query);
  const { where, parts } = whereForScopes(scopes, guildId);
  const cfg = getConfig().ai.vector;
  return searchVectors({
    query: vec,
    model: getConfig().ai.embedding.model,
    where,
    parts,
    k: limit,
    exactThreshold: cfg.exactThreshold,
    coarseK: cfg.coarseK,
  }).map((h) => ({ id: h.ownerId, score: h.score }));
}

export function vectorStatus(): { enabled: boolean; backend: BackendKind | null; model: string; dims: number | null; embedded: number; pending: number } {
  if (!vectorsReady()) return { enabled: false, backend: null, model: '', dims: null, embedded: 0, pending: 0 };
  const { model, dims } = currentModel();
  const embedded = (getDatabase().query('SELECT COUNT(*) AS c FROM vectors WHERE model = ?').get(model) as { c: number }).c;
  return { enabled: true, backend: vectorBackend(), model, dims, embedded, pending: pendingCount() };
}

/** 注册向量化任务：有待处理记忆时投递，一个任务最多连续处理 10 批 */
export function registerVectorJobs(): void {
  registerJobHandler('embed', async () => {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = await embedPendingMemories();
      total += n;
      if (n < EMBED_BATCH) break;
    }
    if (total > 0) console.log(`[Vector] 已向量化 ${total} 条记忆（剩余 ${pendingCount()} 条）`);
  });
  registerScheduler('embed', 60_000, (now) => {
    if (vectorsReady() && pendingCount() > 0) enqueueJob('embed', {}, { priority: PRIORITY.embed, dedupeKey: 'embed' }, now);
  });
}

/** 测试用 */
/** 查询向量缓存的键是聊天原文：/forget-me 时整个清掉 */
export function clearQueryCache(): void {
  queryCache.clear();
}

export function resetVectorServiceForTesting(): void {
  queryCache.clear();
  initialized = false;
  setVectorSearch(null);
}
