import { getDatabase } from '../../storage';
import { LEXICAL_WEIGHTS, escapeLike, finalScore, ftsMatchExpr, fuseRelevance, queryTerms, rrfFuse } from './scoring';
import { touchMemories, type MemoryKind, type MemoryRow, type MemoryScope } from './store';

export type ScopeRef = { scope: MemoryScope; subjectId: string };

export type SearchOptions = {
  query: string;
  /** 指定的主体，或 'all-users' = 所有用户（给了 guildId 时只限本服务器的成员） */
  scopes: ScopeRef[] | 'all-users';
  guildId?: string | null;
  kinds?: MemoryKind[];
  /** 是否包含已被取代的旧版本（"以前…现在…"） */
  includeHistory?: boolean;
  /** 哪些主体的敏感记忆可以返回（只在和本人对话时放行） */
  sensitiveFor: ReadonlySet<string>;
  limit: number;
  offset?: number;
  now?: number;
};

export type ScoredMemory = { row: MemoryRow; score: number };

export type VectorSearchFn = (
  query: string,
  scopes: ScopeRef[] | 'all-users',
  guildId: string | null,
  limit: number
) => Promise<Array<{ id: number; score: number }>>;

let vectorSearch: VectorSearchFn | null = null;

/** 向量检索通道（向量化启用后注册；返回按相似度排好的记忆 id） */
export function setVectorSearch(fn: VectorSearchFn | null): void {
  vectorSearch = fn;
}

type Filter = { sql: string; params: Array<string | number> };

function buildFilter(o: SearchOptions): Filter {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (o.scopes === 'all-users') {
    if (o.guildId) {
      where.push("m.scope = 'user' AND m.subject_id IN (SELECT user_id FROM guild_members WHERE guild_id = ?)");
      params.push(o.guildId);
    } else {
      where.push("m.scope = 'user'");
    }
  } else {
    if (o.scopes.length === 0) return { sql: '0', params: [] };
    const ors = o.scopes.map((s) => {
      if (s.scope === 'relation') {
        params.push(s.subjectId, s.subjectId);
        return "(m.scope = 'relation' AND (m.subject_id = ? OR m.object_id = ?))";
      }
      params.push(s.scope, s.subjectId);
      return '(m.scope = ? AND m.subject_id = ?)';
    });
    where.push(`(${ors.join(' OR ')})`);
  }
  if (!o.includeHistory) where.push("m.status = 'active'");
  if (o.kinds && o.kinds.length) {
    where.push(`m.kind IN (${o.kinds.map(() => '?').join(',')})`);
    params.push(...o.kinds);
  }
  const allowed = [...o.sensitiveFor];
  if (allowed.length) {
    where.push(`(m.sensitive = 0 OR m.subject_id IN (${allowed.map(() => '?').join(',')}))`);
    params.push(...allowed);
  } else {
    where.push('m.sensitive = 0');
  }
  return { sql: where.join(' AND '), params };
}

function ftsCandidates(terms: string[], f: Filter, limit: number): number[] {
  if (terms.length === 0) return [];
  try {
    return (
      getDatabase()
        .query(
          `SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ? AND ${f.sql} ORDER BY bm25(memories_fts) LIMIT ?`
        )
        .all(ftsMatchExpr(terms), ...f.params, limit) as Array<{ id: number }>
    ).map((r) => r.id);
  } catch (e) {
    console.warn('[Memory] 全文检索失败(改用 LIKE):', (e as Error).message);
    return [];
  }
}

function likeCandidates(terms: string[], f: Filter, limit: number): number[] {
  if (terms.length === 0) return [];
  const ors = terms.map(() => "(m.content LIKE ? ESCAPE '\\' OR m.value LIKE ? ESCAPE '\\')").join(' OR ');
  const params: Array<string | number> = [];
  for (const t of terms) params.push(escapeLike(t), escapeLike(t));
  const rows = getDatabase()
    .query(`SELECT m.id, m.content, m.value FROM memories m WHERE ${f.sql} AND (${ors}) LIMIT 300`)
    .all(...f.params, ...params) as Array<{ id: number; content: string; value: string | null }>;
  return rows
    .map((r) => {
      const hay = `${r.content} ${r.value ?? ''}`.toLowerCase();
      return { id: r.id, hits: terms.filter((t) => hay.includes(t.toLowerCase())).length };
    })
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((r) => r.id);
}

/**
 * 混合检索记忆：FTS5（trigram）+ LIKE（短词）+ 向量（启用时），RRF 融合后按相关度 + 重要度 + 时近 + 使用频次排序。
 * 空查询时按置顶、重要度、更新时间列出。返回的条目会累加 access_count。
 */
export async function searchMemories(o: SearchOptions): Promise<{ items: ScoredMemory[]; total: number }> {
  const now = o.now ?? Date.now();
  const f = buildFilter(o);
  const db = getDatabase();
  const offset = o.offset ?? 0;

  if (!o.query.trim()) {
    const total = (db.query(`SELECT COUNT(*) AS c FROM memories m WHERE ${f.sql}`).get(...f.params) as { c: number }).c;
    const rows = db
      .query(
        `SELECT m.* FROM memories m WHERE ${f.sql}
         ORDER BY m.status = 'active' DESC, m.pinned DESC, m.importance DESC, m.updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(...f.params, o.limit, offset) as MemoryRow[];
    touchMemories(rows.map((r) => r.id), now);
    return { items: rows.map((row) => ({ row, score: 0 })), total };
  }

  const terms = queryTerms(o.query);
  const lexical = rrfFuse([ftsCandidates(terms.fts, f, 60), likeCandidates(terms.like, f, 60)], [LEXICAL_WEIGHTS.fts, LEXICAL_WEIGHTS.like]);
  let vector: Map<number, number> | null = null;
  if (vectorSearch) {
    try {
      vector = new Map((await vectorSearch(o.query, o.scopes, o.guildId ?? null, 40)).map((h) => [h.id, h.score]));
    } catch (e) {
      console.warn('[Memory] 向量检索失败(只用全文检索):', (e as Error).message);
    }
  }
  const ids = [...new Set([...lexical.keys(), ...(vector?.keys() ?? [])])];
  if (ids.length === 0) return { items: [], total: 0 };

  // 向量通道返回的 id 也要再过一遍同样的过滤条件（作用域、状态、敏感）；归一化只在通过过滤的候选之间做
  const rows = db
    .query(`SELECT m.* FROM memories m WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${f.sql}`)
    .all(...ids, ...f.params) as MemoryRow[];
  const allowed = new Set(rows.map((r) => r.id));
  const keep = (m: Map<number, number>): Map<number, number> => new Map([...m].filter(([id]) => allowed.has(id)));
  const relevance = fuseRelevance(keep(lexical), vector ? keep(vector) : null);
  const scored = rows
    .map((row) => ({
      row,
      score: finalScore({
        relevance: relevance.get(row.id) ?? 0,
        importance: row.importance,
        updatedAt: row.updated_at,
        accessCount: row.access_count,
        kind: row.kind,
        validUntil: row.valid_until,
        now,
      }),
    }))
    .sort((a, b) => b.score - a.score);
  const page = scored.slice(offset, offset + o.limit);
  touchMemories(page.map((s) => s.row.id), now);
  return { items: page, total: scored.length };
}
