import { getAiConfig } from '@/plugins/ai-chat/config';
import { getDatabase, getDatabaseGeneration } from '@/storage';
import { SLOT_WHITELIST } from '@/plugins/ai-chat/db/schema';
import { bumpForgetEpoch } from '@/plugins/ai-chat/forget-guard';

export type MemoryScope = 'user' | 'guild' | 'self' | 'relation';

export type UserKind = 'fact' | 'preference' | 'trait' | 'event' | 'plan' | 'opinion' | 'habit' | 'alias';
export type GuildKind = 'lore' | 'event' | 'rule' | 'meme' | 'topic' | 'episode' | 'bot_alias';
export type SelfKind = 'opinion' | 'preference' | 'experience' | 'promise' | 'habit';
export type RelationKind = 'relationship';
export type MemoryKind = UserKind | GuildKind | SelfKind | RelationKind;

export type MemoryOrigin = 'extractor' | 'appraisal' | 'reflection' | 'tool' | 'user' | 'legacy';

export const KINDS_BY_SCOPE: Record<MemoryScope, readonly MemoryKind[]> = {
  user: ['fact', 'preference', 'trait', 'event', 'plan', 'opinion', 'habit', 'alias'],
  guild: ['lore', 'event', 'rule', 'meme', 'topic', 'episode', 'bot_alias'],
  self: ['opinion', 'preference', 'experience', 'promise', 'habit'],
  relation: ['relationship'],
};

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  trait: '特点',
  event: '事件',
  plan: '计划',
  opinion: '观点',
  habit: '习惯',
  alias: '外号',
  lore: '设定',
  rule: '规矩',
  meme: '梗',
  topic: '话题',
  episode: '片段',
  bot_alias: '对你的叫法',
  experience: '经历',
  promise: '承诺',
  relationship: '关系',
};

/** 只能由本人决定的单值属性：别人的转述、模型替别人写都不算 */
export const SELF_ONLY_SLOTS: readonly string[] = ['preferred_name', 'pronouns'];

export const SLOT_LABEL: Record<string, string> = {
  preferred_name: '希望的称呼',
  pronouns: '代词',
  gender: '性别',
  birthday: '生日',
  age_range: '年龄段',
  location: '所在地',
  timezone: '时区',
  occupation: '职业',
  school: '学校',
  languages: '语言',
  pets: '宠物',
  relationship_status: '感情状况',
};

export type MemoryRow = {
  id: number;
  scope: MemoryScope;
  subject_id: string;
  object_id: string | null;
  guild_id: string | null;
  kind: MemoryKind;
  slot: string | null;
  value: string | null;
  content: string;
  importance: number;
  confidence: number;
  pinned: number;
  sensitive: number;
  status: 'active' | 'superseded';
  superseded_by: number | null;
  origin: MemoryOrigin;
  source_user_id: string | null;
  participants: string | null;
  evidence: string | null;
  images: string | null;
  event_at: number | null;
  valid_until: number | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  embed_model: string | null;
};

export type NewMemory = {
  scope: MemoryScope;
  subjectId: string;
  objectId?: string | null;
  guildId?: string | null;
  kind: MemoryKind;
  slot?: string | null;
  value?: string | null;
  content: string;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  sensitive?: boolean;
  origin: MemoryOrigin;
  sourceUserId?: string | null;
  /** 共享记忆（服务器 / bot 自己）是从哪些成员的发言来的；/forget-me 按它删除 */
  participants?: string[];
  evidence?: string[];
  images?: string[];
  eventAt?: number | null;
  validUntil?: number | null;
};

export const MAX_MEMORY_CHARS = 500;

/** participants 列（用户 ID 的 JSON 数组）→ 数组 */
export function parseParticipants(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function serializeParticipants(ids: readonly (string | null | undefined)[] | undefined): string | null {
  const uniq = [...new Set((ids ?? []).filter((x): x is string => !!x))];
  return uniq.length ? JSON.stringify(uniq) : null;
}

export function isValidKind(scope: MemoryScope, kind: string): kind is MemoryKind {
  return (KINDS_BY_SCOPE[scope] as readonly string[]).includes(kind);
}

export function isValidSlot(slot: string): boolean {
  return SLOT_WHITELIST.includes(slot);
}

function clampImportance(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(10, v)) : 5;
}

function clampConfidence(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
}

function pinCap(scope: MemoryScope): number {
  const core = getAiConfig().memory.core;
  return scope === 'guild' ? core.guildPins : scope === 'self' ? core.selfPins : scope === 'user' ? core.userPins : 0;
}

export function getMemory(id: number): MemoryRow | null {
  return getDatabase().query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
}

/**
 * 置顶超出容量时，按"重要度 × 时近"把最不该占位的降回档案层（不删除）。返回被降级的 id。
 * keepId：本次刚置顶的那条不参与降级。
 */
export function enforcePinCap(scope: MemoryScope, subjectId: string, keepId?: number, now: number = Date.now()): number[] {
  const cap = pinCap(scope);
  const db = getDatabase();
  const pinned = db
    .query("SELECT id, importance, updated_at FROM memories WHERE scope = ? AND subject_id = ? AND status = 'active' AND pinned = 1")
    .all(scope, subjectId) as Array<{ id: number; importance: number; updated_at: number }>;
  if (pinned.length <= cap) return [];
  const score = (m: { importance: number; updated_at: number }): number =>
    m.importance * Math.pow(0.5, (now - m.updated_at) / (90 * 86400000));
  const candidates = pinned.filter((m) => m.id !== keepId).sort((a, b) => score(a) - score(b));
  const demote = candidates.slice(0, pinned.length - cap).map((m) => m.id);
  for (const id of demote) db.run('UPDATE memories SET pinned = 0 WHERE id = ?', [id]);
  return demote;
}

/**
 * 写入一条记忆。带 slot 的会取代该主体同一 slot 的现有记忆（旧的标为 superseded，保留历史）。
 * 重要度达到 autoPinImportance 的自动置顶（受容量限制）。
 */
export function addMemory(m: NewMemory, now: number = Date.now()): MemoryRow {
  if (!isValidKind(m.scope, m.kind)) throw new Error(`记忆类型 ${m.kind} 不适用于 ${m.scope}`);
  if (m.slot && !isValidSlot(m.slot)) throw new Error(`未知的 slot: ${m.slot}`);
  const content = String(m.content || '').trim().slice(0, MAX_MEMORY_CHARS);
  if (!content) throw new Error('记忆内容为空');
  const db = getDatabase();
  const importance = clampImportance(m.importance ?? 5);
  const autoPin = m.scope !== 'relation' && m.kind !== 'episode' && importance >= getAiConfig().memory.core.autoPinImportance;
  const pinned = m.pinned ?? autoPin;

  let row!: MemoryRow;
  db.transaction(() => {
    const prev = m.slot
      ? (db
          .query("SELECT id FROM memories WHERE scope = ? AND subject_id = ? AND slot = ? AND status = 'active'")
          .get(m.scope, m.subjectId, m.slot) as { id: number } | null)
      : null;
    if (prev) db.run("UPDATE memories SET status = 'superseded', pinned = 0, updated_at = ? WHERE id = ?", [now, prev.id]);

    const res = db.run(
      `INSERT INTO memories (scope, subject_id, object_id, guild_id, kind, slot, value, content, importance, confidence,
                             pinned, sensitive, origin, source_user_id, participants, evidence, images, event_at, valid_until,
                             created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.scope,
        m.subjectId,
        m.objectId ?? null,
        m.guildId ?? null,
        m.kind,
        m.slot ?? null,
        m.value ? String(m.value).trim().slice(0, 80) : null,
        content,
        importance,
        clampConfidence(m.confidence ?? 0.8),
        pinned ? 1 : 0,
        m.sensitive ? 1 : 0,
        m.origin,
        m.sourceUserId ?? null,
        serializeParticipants(m.participants),
        m.evidence && m.evidence.length ? JSON.stringify(m.evidence.slice(0, 20)) : null,
        m.images && m.images.length ? JSON.stringify(m.images.slice(0, 6)) : null,
        m.eventAt ?? null,
        m.validUntil ?? null,
        now,
        now,
      ]
    );
    const id = Number(res.lastInsertRowid);
    if (prev) db.run('UPDATE memories SET superseded_by = ? WHERE id = ?', [id, prev.id]);
    if (pinned) enforcePinCap(m.scope, m.subjectId, id, now);
    row = getMemory(id)!;
  })();
  return row;
}

export type MemoryPatch = {
  content?: string;
  value?: string | null;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  sensitive?: boolean;
  eventAt?: number | null;
  validUntil?: number | null;
  /** 这次修改的信息来源（谁说的） */
  sourceUserId?: string | null;
  addEvidence?: string[];
  addParticipants?: string[];
};

/** 修改一条有效记忆；内容变化时清掉向量标记，交给后台重算。返回是否修改了。 */
export function updateMemory(id: number, patch: MemoryPatch, now: number = Date.now()): boolean {
  const cur = getMemory(id);
  if (!cur || cur.status !== 'active') return false;
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null): void => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (patch.content !== undefined) {
    const c = String(patch.content).trim().slice(0, MAX_MEMORY_CHARS);
    if (c && c !== cur.content) {
      set('content', c);
      set('embed_model', null);
    }
  }
  if (patch.value !== undefined) set('value', patch.value ? String(patch.value).trim().slice(0, 80) : null);
  if (patch.importance !== undefined) set('importance', clampImportance(patch.importance));
  if (patch.confidence !== undefined) set('confidence', clampConfidence(patch.confidence));
  if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0);
  if (patch.sensitive !== undefined) set('sensitive', patch.sensitive ? 1 : 0);
  if (patch.eventAt !== undefined) set('event_at', patch.eventAt);
  if (patch.validUntil !== undefined) set('valid_until', patch.validUntil);
  if (patch.sourceUserId !== undefined) set('source_user_id', patch.sourceUserId);
  if (patch.addEvidence && patch.addEvidence.length) {
    const ev = new Set<string>(cur.evidence ? (JSON.parse(cur.evidence) as string[]) : []);
    for (const e of patch.addEvidence) ev.add(e);
    set('evidence', JSON.stringify([...ev].slice(-20)));
  }
  if (patch.addParticipants && patch.addParticipants.length) {
    const merged = serializeParticipants([...parseParticipants(cur.participants), ...patch.addParticipants]);
    if (merged !== cur.participants) set('participants', merged);
  }
  if (sets.length === 0) return false;
  set('updated_at', now);
  params.push(id);
  getDatabase().run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);
  if (patch.pinned) enforcePinCap(cur.scope, cur.subject_id, id, now);
  if (patch.sensitive && !cur.sensitive) invalidateProfilesOf(cur);
  return true;
}

/** 记忆从公开变成敏感（改了标记、或被敏感的新版本取代）：已经写进画像 / 反思的内容别人还看得到，立即失效、之后按可公开的数据重新生成 */
function invalidateProfilesOf(row: Pick<MemoryRow, 'scope' | 'subject_id' | 'object_id'>): void {
  if (row.scope === 'relation') invalidateProfiles('user', row.object_id ? [row.subject_id, row.object_id] : [row.subject_id]);
  else invalidateProfiles(row.scope, [row.subject_id]);
}

/** 用一条新记忆取代旧的（旧的保留为 superseded，模型可以看到"以前…现在…"） */
export function supersedeMemory(oldId: number, next: NewMemory, now: number = Date.now()): MemoryRow | null {
  const cur = getMemory(oldId);
  if (!cur || cur.status !== 'active') return null;
  let row: MemoryRow | null = null;
  getDatabase().transaction(() => {
    getDatabase().run("UPDATE memories SET status = 'superseded', pinned = 0, updated_at = ? WHERE id = ?", [now, oldId]);
    row = addMemory({ ...next, pinned: next.pinned ?? (cur.pinned === 1 ? true : undefined) }, now);
    getDatabase().run('UPDATE memories SET superseded_by = ? WHERE id = ?', [row.id, oldId]);
    if (next.sensitive && !cur.sensitive) invalidateProfilesOf(cur);
  })();
  return row;
}

/** 物理删除一条记忆（连同历史版本链上指向它的引用、以及向量） */
export function deleteMemory(id: number): boolean {
  const db = getDatabase();
  let changed = false;
  db.transaction(() => {
    const row = db.query('SELECT scope, subject_id, object_id FROM memories WHERE id = ?').get(id) as
      | { scope: MemoryScope; subject_id: string; object_id: string | null }
      | null;
    db.run('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?', [id]);
    changed = db.run('DELETE FROM memories WHERE id = ?', [id]).changes > 0;
    if (changed && hasVectorsTable()) db.run("DELETE FROM vectors WHERE owner_type = 'memory' AND owner_id = ?", [id]);
    if (changed && row) {
      // 画像是从记忆写出来的：删掉的事画像里也有，让画像失效，之后按剩下的记忆重新生成
      invalidateProfilesOf(row);
    }
  })();
  // 正在进行中的画像 / 提炼任务手里可能还拿着这条记忆：让它们写入前放弃、按删除后的数据重做
  if (changed) bumpForgetEpoch();
  return changed;
}

/**
 * 让画像失效（源数据被删除时用）：画像和成员的未置顶反思特点都是从记忆汇总出来的，一起删掉，之后按剩下的记忆重新生成。
 * 反思特点存成记忆，不一起删的话，重新生成画像时又会被当成资料读进去。返回删除的行数。
 */
export function invalidateProfiles(scope: Exclude<MemoryScope, 'relation'>, subjectIds: readonly string[]): number {
  const db = getDatabase();
  let n = 0;
  for (let i = 0; i < subjectIds.length; i += 500) {
    const chunk = subjectIds.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    n += db.run(`DELETE FROM profiles WHERE scope = ? AND subject_id IN (${marks})`, [scope, ...chunk]).changes;
    if (scope !== 'user') continue;
    const traits = db
      .query(`SELECT id FROM memories WHERE scope = 'user' AND origin = 'reflection' AND pinned = 0 AND subject_id IN (${marks})`)
      .all(...chunk) as Array<{ id: number }>;
    for (const t of traits) {
      db.run('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?', [t.id]);
      db.run('DELETE FROM memories WHERE id = ?', [t.id]);
      if (hasVectorsTable()) db.run("DELETE FROM vectors WHERE owner_type = 'memory' AND owner_id = ?", [t.id]);
      n++;
    }
  }
  return n;
}

/** 删除一条记忆以及被它取代过的所有旧版本（用户要求忘掉时用）；返回删除的条数 */
export function deleteMemoryChain(id: number): number {
  const db = getDatabase();
  const ids = [id];
  const seen = new Set(ids);
  const older = db.prepare('SELECT id FROM memories WHERE superseded_by = ?');
  for (let i = 0; i < ids.length; i++) {
    for (const o of older.all(ids[i]) as Array<{ id: number }>) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        ids.push(o.id);
      }
    }
  }
  let n = 0;
  db.transaction(() => {
    for (const x of ids) if (deleteMemory(x)) n++;
  })();
  return n;
}

let vectorsTableKnown: boolean | null = null;
let vectorsTableGen = -1;
function hasVectorsTable(): boolean {
  // vectors 表在向量化的迁移里才有；按数据库代号缓存检查结果
  const gen = getDatabaseGeneration();
  if (vectorsTableKnown === null || gen !== vectorsTableGen) {
    vectorsTableKnown = !!getDatabase().query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors'").get();
    vectorsTableGen = gen;
  }
  return vectorsTableKnown;
}

/** 被检索/注入使用过：access_count +1 */
export function touchMemories(ids: number[], now: number = Date.now()): void {
  if (ids.length === 0) return;
  getDatabase().run(
    `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [now, ...ids]
  );
}

export type ListFilter = {
  scope: MemoryScope;
  subjectId: string;
  includeHistory?: boolean;
  kinds?: MemoryKind[];
  pinnedOnly?: boolean;
  includeSensitive?: boolean;
  limit?: number;
  offset?: number;
};

/** 按主体列出记忆（置顶、重要度、更新时间降序） */
export function listMemories(f: ListFilter): MemoryRow[] {
  const where = ['scope = ?', f.scope === 'relation' ? '(subject_id = ? OR object_id = ?)' : 'subject_id = ?'];
  const params: Array<string | number> = f.scope === 'relation' ? [f.scope, f.subjectId, f.subjectId] : [f.scope, f.subjectId];
  if (!f.includeHistory) where.push("status = 'active'");
  if (f.pinnedOnly) where.push('pinned = 1');
  if (!f.includeSensitive) where.push('sensitive = 0');
  if (f.kinds && f.kinds.length) {
    where.push(`kind IN (${f.kinds.map(() => '?').join(',')})`);
    params.push(...f.kinds);
  }
  params.push(f.limit ?? 50, f.offset ?? 0);
  return getDatabase()
    .query(
      `SELECT * FROM memories WHERE ${where.join(' AND ')}
       ORDER BY status = 'active' DESC, pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params) as MemoryRow[];
}

/** 某主体的有效记忆按类型计数（"记忆目录"用） */
export function countByKind(scope: MemoryScope, subjectId: string, includeSensitive: boolean): Array<{ kind: MemoryKind; n: number }> {
  return getDatabase()
    .query(
      `SELECT kind, COUNT(*) AS n FROM memories
       WHERE scope = ? AND subject_id = ? AND status = 'active' ${includeSensitive ? '' : 'AND sensitive = 0'}
       GROUP BY kind ORDER BY n DESC`
    )
    .all(scope, subjectId) as Array<{ kind: MemoryKind; n: number }>;
}

/** 某主体当前有效的 slot 值 */
export function activeSlot(scope: MemoryScope, subjectId: string, slot: string): MemoryRow | null {
  return getDatabase()
    .query("SELECT * FROM memories WHERE scope = ? AND subject_id = ? AND slot = ? AND status = 'active'")
    .get(scope, subjectId, slot) as MemoryRow | null;
}
