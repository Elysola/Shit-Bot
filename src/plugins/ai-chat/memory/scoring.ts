/** 检索打分（纯函数）。公式见 PLAN §9.4。 */

export const RRF_K = 60;
const DAY_MS = 86400000;

/**
 * 加权倒数排名融合：第 j 个列表里排第 r（从 1 开始）贡献 weights[j]/(K + r)；同一 id 在多个列表出现则累加。
 * 权重缺省为 1。
 */
export function rrfFuse(lists: ReadonlyArray<readonly number[]>, weights: readonly number[] = []): Map<number, number> {
  const out = new Map<number, number>();
  lists.forEach((list, j) => {
    const w = weights[j] ?? 1;
    list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + w / (RRF_K + i + 1)));
  });
  return out;
}

/** 字面通道（全文检索、LIKE 兜底）之间的 RRF 权重：LIKE 的双字片段噪声更大 */
export const LEXICAL_WEIGHTS = { fts: 1, like: 0.6 } as const;

/**
 * 有向量时的相关度 = 0.8 × 向量相似度 + 0.2 × 字面得分（两者都在候选集内 min-max 归一化）。
 * 真实评测（bge-m3，40 条记忆 / 20 个中文问题）：按名次做 RRF 时，向量第 1 名和第 3 名的分数只差约 3%，
 * 一条字面上碰巧重合（"准备""出国"）的记忆会把正确答案挤出前 5（recall@5 0.95，只用向量是 1.00）；
 * 改用相似度分值融合后，字面重合只在语义相近的候选之间起区分作用。
 */
export const VECTOR_SHARE = 0.8;

/** 把一组分数线性映射到 [0,1]（全部相等时都为 1） */
export function minMax(scores: Map<number, number>): Map<number, number> {
  const vals = [...scores.values()];
  if (vals.length === 0) return new Map();
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const out = new Map<number, number>();
  for (const [id, v] of scores) out.set(id, hi > lo ? (v - lo) / (hi - lo) : 1);
  return out;
}

/** 字面得分（RRF）与向量相似度融合成 [0,1] 的相关度；没有向量结果时就是字面得分 */
export function fuseRelevance(lexical: Map<number, number>, vector: Map<number, number> | null): Map<number, number> {
  const lex = minMax(lexical);
  if (!vector || vector.size === 0) return lex;
  const vec = minMax(vector);
  const out = new Map<number, number>();
  for (const id of new Set([...lex.keys(), ...vec.keys()])) {
    out.set(id, VECTOR_SHARE * (vec.get(id) ?? 0) + (1 - VECTOR_SHARE) * (lex.get(id) ?? 0));
  }
  return out;
}

export type ScoreInput = {
  /** 相关度 [0,1]；没有相关度检索（空查询）时为 0 */
  relevance: number;
  importance: number;
  updatedAt: number;
  accessCount: number;
  kind: string;
  validUntil: number | null;
  now: number;
};

/** 最终分 = 相关度 + 重要度 + 时近 + 使用频次；过期的计划降权 */
export function finalScore(i: ScoreInput): number {
  const ageDays = Math.max(0, (i.now - i.updatedAt) / DAY_MS);
  let s = 1.0 * i.relevance + 0.35 * (i.importance / 10) + 0.25 * Math.pow(0.5, ageDays / 30) + 0.05 * Math.log1p(i.accessCount);
  if (i.kind === 'plan' && i.validUntil !== null && i.validUntil < i.now) s *= 0.3;
  return s;
}

// 检索时没有区分度的常见双字词
const BIGRAM_STOP = new Set([
  '什么', '怎么', '为什', '么样', '一个', '我们', '你们', '他们', '她们', '这个', '那个', '是不', '不是', '有没', '没有',
  '可以', '就是', '还是', '自己', '知道', '现在', '时候', '的人', '了吗', '吗？', '一下', '一些', '哪里', '哪个', '怎样',
  '最近', '之前', '以前', '喜欢', '觉得', '是什', '有什', '谁是', '他的', '她的', '我的', '你的', '的是',
]);

const CJK = /[㐀-鿿]/;

export type QueryTerms = { fts: string[]; like: string[] };

/**
 * 把查询拆成两类检索词：
 * - fts：≥3 字的词（trigram 索引可用），中文长词再切成重叠的三字片段，提高召回；
 * - like：2 字词（trigram 用不上，走 LIKE 兜底），中文长词也切出双字片段，过滤掉没有区分度的常见词。
 */
export function queryTerms(query: string): QueryTerms {
  const tokens = String(query || '')
    .split(/[\s,，。！？!?、;；:：'"“”‘’()（）【】[\]<>《》/|~·…]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
  const fts = new Set<string>();
  const like = new Set<string>();
  for (const t of tokens) {
    const chars = [...t];
    if (chars.length >= 3) {
      fts.add(t);
      if (CJK.test(t) && chars.length > 3) {
        for (let i = 0; i + 3 <= chars.length && fts.size < 24; i++) fts.add(chars.slice(i, i + 3).join(''));
      }
      if (CJK.test(t)) {
        for (let i = 0; i + 2 <= chars.length && like.size < 16; i++) {
          const bi = chars.slice(i, i + 2).join('');
          if (CJK.test(bi) && !BIGRAM_STOP.has(bi)) like.add(bi);
        }
      }
    } else if (chars.length === 2) {
      if (!BIGRAM_STOP.has(t)) like.add(t);
    } else if (tokens.length === 1) {
      like.add(t);
    }
  }
  return { fts: [...fts], like: [...like] };
}

/** FTS5 MATCH 表达式：每个词作为短语（双引号转义）用 OR 连接 */
export function ftsMatchExpr(terms: readonly string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export function escapeLike(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}
