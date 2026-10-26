import type { Database } from 'bun:sqlite';
import { getDatabase, getDatabaseGeneration } from '@/storage';
import { blobToFloat32, dot, hamming, toBinary } from './binary';

/**
 * 向量存储与检索（PLAN §9.2，"三段式"）：
 * - vectors 普通表是唯一数据源（归一化 float32），任何环境都能读；
 * - 精确计算：sqlite 后端用 sqlite-vec 的 vec_distance_cosine()，js 后端在 JS 里算点积；
 * - 大范围检索先二值粗筛（sqlite：vec0 bit[] 索引；js：内存里的二值码）再精确重排。
 * 两个后端读写同一张表，切换不需要迁移数据；二值索引是派生的，可随时重建。
 */

export type BackendKind = 'sqlite' | 'js';

export type VectorWhere = { sql: string; params: Array<string | number> };

export type VectorSearch = {
  query: Float32Array;
  model: string;
  /** 额外的过滤条件（列名用 v. 前缀） */
  where: VectorWhere;
  /** 粗筛时要扫的分区 */
  parts: string[];
  k: number;
  exactThreshold: number;
  coarseK: number;
};

export type VectorHit = { ownerId: number; score: number };

let backend: BackendKind = 'js';
let extensionPath: string | null = null;
let loadedGeneration = -1;
// js 后端的二值码缓存：`${model}|${part}` → vectors.id → 二值码
const jsCodes = new Map<string, Map<number, Uint8Array>>();
let cacheGeneration = -1;

/** loadedOnCurrent：扩展已经在当前连接上加载过（初始化时），只需在连接被替换后重新加载 */
export function setVectorBackend(kind: BackendKind, loadablePath: string | null, loadedOnCurrent = false): void {
  backend = kind;
  extensionPath = loadablePath;
  loadedGeneration = loadedOnCurrent ? getDatabaseGeneration() : -1;
  jsCodes.clear();
}

export function vectorBackend(): BackendKind {
  return backend;
}

/** 取数据库连接；sqlite 后端在连接被替换后（测试换内存库）自动重新加载扩展 */
function db(): Database {
  const d = getDatabase();
  const gen = getDatabaseGeneration();
  if (gen !== cacheGeneration) {
    jsCodes.clear();
    cacheGeneration = gen;
  }
  if (backend === 'sqlite' && extensionPath && loadedGeneration !== gen) {
    d.loadExtension(extensionPath);
    loadedGeneration = gen;
  }
  return d;
}

function binTable(dims: number): string {
  return `vec_bin_${dims}`;
}

function binTableExists(dims: number): boolean {
  return !!db().query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(binTable(dims));
}

/** sqlite 后端：确保该维度的二值索引存在（维度必须是 8 的倍数） */
export function ensureBinIndex(dims: number): boolean {
  if (backend !== 'sqlite' || dims % 8 !== 0) return false;
  db().run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${binTable(dims)} USING vec0(part TEXT partition key, embedding bit[${dims}])`);
  return true;
}

/** 用 vectors 表重建二值索引（不调任何接口）；返回索引条数 */
export function rebuildBinIndex(model: string, dims: number): number {
  if (!ensureBinIndex(dims)) return 0;
  const d = db();
  const table = binTable(dims);
  d.transaction(() => {
    d.run(`DELETE FROM ${table}`);
    d.run(`INSERT INTO ${table}(rowid, part, embedding) SELECT id, part, vec_quantize_binary(vector) FROM vectors WHERE model = ? AND dims = ?`, [
      model,
      dims,
    ]);
  })();
  return (d.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

export function binIndexCount(dims: number): number | null {
  if (backend !== 'sqlite' || !binTableExists(dims)) return null;
  return (db().query(`SELECT COUNT(*) AS c FROM ${binTable(dims)}`).get() as { c: number }).c;
}

/** 删掉二值索引里已经没有对应向量的条目 */
export function pruneBinIndex(dims: number): void {
  if (backend !== 'sqlite' || !binTableExists(dims)) return;
  db().run(`DELETE FROM ${binTable(dims)} WHERE rowid NOT IN (SELECT id FROM vectors)`);
}

/** 删除所有维度的二值索引（换模型时）；js 后端下无法加载 vec0 模块，留给下次 sqlite 后端处理 */
export function dropBinIndexes(): void {
  if (backend !== 'sqlite') return;
  // vec0 会建若干 vec_bin_<dims>_xxx 影子表，只删虚拟表本身（影子表随之删除）
  const tables = db().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'vec_bin_[0-9]*'").all() as Array<{ name: string }>;
  for (const t of tables) {
    if (/^vec_bin_\d+$/.test(t.name)) db().run(`DROP TABLE IF EXISTS ${t.name}`);
  }
}

/** 写入/替换一条向量（按 owner 去重），同步维护二值索引或 js 缓存；返回 vectors.id */
export function upsertVector(ownerType: string, ownerId: number, scopeKey: string, part: string, model: string, vec: Float32Array, now: number = Date.now()): number {
  const d = db();
  const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  d.run(
    `INSERT INTO vectors (owner_type, owner_id, scope_key, part, model, dims, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET scope_key = excluded.scope_key, part = excluded.part, model = excluded.model,
       dims = excluded.dims, vector = excluded.vector, created_at = excluded.created_at`,
    [ownerType, ownerId, scopeKey, part, model, vec.length, blob, now]
  );
  const id = (d.query('SELECT id FROM vectors WHERE owner_type = ? AND owner_id = ?').get(ownerType, ownerId) as { id: number }).id;
  if (backend === 'sqlite') {
    if (ensureBinIndex(vec.length)) {
      const table = binTable(vec.length);
      d.run(`DELETE FROM ${table} WHERE rowid = ?`, [id]);
      d.run(`INSERT INTO ${table}(rowid, part, embedding) VALUES (?, ?, vec_quantize_binary(?))`, [id, part, blob]);
    }
  } else {
    const cache = jsCodes.get(`${model}|${part}`);
    if (cache) cache.set(id, toBinary(vec));
  }
  return id;
}

/** 立即删除这些对象的向量，连同二值索引条目和 js 缓存（/forget-me 用，不等后台清理） */
export function deleteVectorsOf(ownerType: string, ownerIds: number[]): number {
  if (ownerIds.length === 0) return 0;
  const d = db();
  let removed = 0;
  for (let i = 0; i < ownerIds.length; i += 500) {
    const chunk = ownerIds.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    const rows = d.query(`SELECT id, dims FROM vectors WHERE owner_type = ? AND owner_id IN (${marks})`).all(ownerType, ...chunk) as Array<{ id: number; dims: number }>;
    if (rows.length === 0) continue;
    d.run(`DELETE FROM vectors WHERE owner_type = ? AND owner_id IN (${marks})`, [ownerType, ...chunk]);
    removed += rows.length;
    const ids = rows.map((r) => r.id);
    if (backend === 'sqlite') {
      for (const dims of new Set(rows.map((r) => r.dims))) {
        if (binTableExists(dims)) d.run(`DELETE FROM ${binTable(dims)} WHERE rowid IN (${ids.map(() => '?').join(',')})`, ids);
      }
    } else {
      for (const cache of jsCodes.values()) for (const id of ids) cache.delete(id);
    }
  }
  return removed;
}

function exact(o: VectorSearch): VectorHit[] {
  const d = db();
  const blob = new Uint8Array(o.query.buffer, o.query.byteOffset, o.query.byteLength);
  if (backend === 'sqlite') {
    const rows = d
      .query(`SELECT v.owner_id, vec_distance_cosine(v.vector, ?) AS dist FROM vectors v WHERE v.model = ? AND (${o.where.sql}) ORDER BY dist LIMIT ?`)
      .all(blob, o.model, ...o.where.params, o.k) as Array<{ owner_id: number; dist: number }>;
    return rows.map((r) => ({ ownerId: r.owner_id, score: 1 - r.dist }));
  }
  const rows = d.query(`SELECT v.owner_id, v.vector FROM vectors v WHERE v.model = ? AND (${o.where.sql})`).all(o.model, ...o.where.params) as Array<{
    owner_id: number;
    vector: Uint8Array;
  }>;
  return rows
    .map((r) => ({ ownerId: r.owner_id, score: dot(blobToFloat32(r.vector), o.query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, o.k);
}

function jsCodesFor(model: string, part: string): Map<number, Uint8Array> {
  const key = `${model}|${part}`;
  let cache = jsCodes.get(key);
  if (!cache) {
    cache = new Map();
    const rows = db().query('SELECT id, vector FROM vectors WHERE model = ? AND part = ?').all(model, part) as Array<{ id: number; vector: Uint8Array }>;
    for (const r of rows) cache.set(r.id, toBinary(blobToFloat32(r.vector)));
    jsCodes.set(key, cache);
  }
  return cache;
}

/** 二值粗筛：返回每个分区汉明距离最近的 coarseK 个 vectors.id */
function coarse(o: VectorSearch): number[] {
  const ids: number[] = [];
  if (backend === 'sqlite') {
    const table = binTable(o.query.length);
    const blob = new Uint8Array(o.query.buffer, o.query.byteOffset, o.query.byteLength);
    for (const part of o.parts) {
      const rows = db()
        .query(`SELECT rowid FROM ${table} WHERE embedding MATCH vec_quantize_binary(?) AND k = ? AND part = ?`)
        .all(blob, o.coarseK, part) as Array<{ rowid: number }>;
      ids.push(...rows.map((r) => r.rowid));
    }
    return ids;
  }
  const q = toBinary(o.query);
  for (const part of o.parts) {
    const scored: Array<[number, number]> = [];
    for (const [id, code] of jsCodesFor(o.model, part)) scored.push([hamming(code, q), id]);
    scored.sort((a, b) => a[0] - b[0]);
    ids.push(...scored.slice(0, o.coarseK).map((s) => s[1]));
  }
  return ids;
}

function rescore(ids: number[], o: VectorSearch): VectorHit[] {
  if (ids.length === 0) return [];
  const where = { sql: `v.id IN (${ids.map(() => '?').join(',')}) AND (${o.where.sql})`, params: [...ids, ...o.where.params] };
  return exact({ ...o, where });
}

function coarseAvailable(o: VectorSearch): boolean {
  if (o.parts.length === 0) return false;
  if (backend === 'js') return true;
  return o.query.length % 8 === 0 && binTableExists(o.query.length);
}

/** 检索：范围小就精确算；范围大就二值粗筛 + 精确重排（粗筛漏得太多时退回精确） */
export function searchVectors(o: VectorSearch): VectorHit[] {
  const count = (db().query(`SELECT COUNT(*) AS c FROM vectors v WHERE v.model = ? AND (${o.where.sql})`).get(o.model, ...o.where.params) as { c: number }).c;
  if (count === 0) return [];
  if (count <= o.exactThreshold || !coarseAvailable(o)) return exact(o);
  const hits = rescore(coarse(o), o);
  if (hits.length < Math.min(o.k, count)) return exact(o);
  return hits;
}

/** 测试用：重置模块状态 */
export function resetVectorStoreForTesting(): void {
  backend = 'js';
  extensionPath = null;
  loadedGeneration = -1;
  jsCodes.clear();
}
