import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { getConfig } from '../config';
import { resolveProjectPath } from '../storage';
import { personFromDb } from './identity';

/** lorebook 条目（T0 写死层：人写、AI 只读） */
export type LoreEntry = {
  id: string;
  /** null = 所有服务器通用（来自 global.yaml） */
  guildId: string | null;
  /** guild = 服务器相关；self = 关于 bot 自己；user:<id> = 关于某个成员（该成员被提到时也会触发） */
  target: string;
  /** constant = 每轮都带；keywords = 命中关键词才带 */
  mode: 'constant' | 'keywords';
  keywords: string[];
  content: string;
  /** 越大越优先放进预算 */
  priority: number;
};

const LORE_EXT = /\.(ya?ml|json)$/i;

let entries: LoreEntry[] = [];
// 每个文件最近一次解析成功的条目（文件改坏时回退用）
const lastGood = new Map<string, LoreEntry[]>();
let loadedDir: string | null = null;
let watcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

export function loreDir(): string {
  return resolveProjectPath(getConfig().ai.lore.dir);
}

function parseEntries(raw: unknown, guildId: string | null, file: string): LoreEntry[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
    ? ((raw as { entries: unknown[] }).entries)
    : Array.isArray(raw)
      ? raw
      : [];
  const out: LoreEntry[] = [];
  list.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const r = e as Record<string, unknown>;
    const content = typeof r.content === 'string' ? r.content.trim() : '';
    if (!content) {
      console.warn(`[Lore] ${file} 第 ${i + 1} 条缺少 content，已忽略`);
      return;
    }
    const keywords = Array.isArray(r.keywords) ? r.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
    const target = typeof r.target === 'string' && /^(guild|self|user:\d{15,25})$/.test(r.target) ? r.target : 'guild';
    const mode = r.mode === 'keywords' || (r.mode === undefined && keywords.length > 0) ? 'keywords' : 'constant';
    out.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `${path.basename(file)}#${i + 1}`,
      guildId,
      target,
      mode,
      keywords,
      content: content.slice(0, 2000),
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 0,
    });
  });
  return out;
}

/** （重新）加载 lorebook 目录：global.yaml 对所有服务器生效，<guildId>.yaml 只对该服务器生效 */
export function loadLore(): number {
  const dir = loreDir();
  loadedDir = dir;
  const next: LoreEntry[] = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => LORE_EXT.test(x))) {
      const base = f.replace(LORE_EXT, '');
      const guildId = /^\d{15,25}$/.test(base) ? base : base === 'global' ? null : undefined;
      if (guildId === undefined) {
        console.warn(`[Lore] 文件名 ${f} 既不是服务器 ID 也不是 global，已忽略`);
        continue;
      }
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const parsed = parseEntries(/\.json$/i.test(f) ? JSON.parse(raw) : parseYaml(raw), guildId, f);
        lastGood.set(path.join(dir, f), parsed);
        next.push(...parsed);
      } catch (e) {
        // 改坏了：这个文件继续用上一次解析成功的内容，别让群规之类的常驻条目突然消失
        const prev = lastGood.get(path.join(dir, f));
        console.warn(`[Lore] 解析 ${f} 失败${prev ? '，继续使用上一次的有效版本' : '，已跳过'}:`, (e as Error).message);
        if (prev) next.push(...prev);
      }
    }
  }
  entries = next;
  return entries.length;
}

export function watchLore(): void {
  if (watcher) return;
  const dir = loreDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        console.log(`[Lore] lorebook 已重新加载（${loadLore()} 条）`);
      }, 500);
    });
    watcher.on('error', (e) => console.warn('[Lore] 监听 lorebook 目录出错:', e.message));
  } catch (e) {
    console.warn(`[Lore] 无法监听 lorebook 目录 (${dir})，修改后需重启生效:`, (e as Error).message);
  }
}

export function stopWatchingLore(): void {
  watcher?.close();
  watcher = null;
}

function ensureLoaded(): void {
  if (loadedDir !== loreDir()) loadLore();
}

export type LoreQuery = {
  guildId: string | null;
  /** 用来匹配关键词的文本：本条消息、引用消息、最近几条频道消息 */
  texts: string[];
  /** 本轮涉及的人（说话人、被 @ 的人）：target=user:<id> 的条目会被触发 */
  userIds: string[];
};

/** 按优先级挑选本轮要带的条目：常驻条目在前，然后是命中的关键词条目，总长度不超过 budgetChars */
export function selectLore(q: LoreQuery, budgetChars: number): LoreEntry[] {
  ensureLoaded();
  if (budgetChars <= 0) return [];
  const haystack = q.texts.join('\n').toLowerCase();
  const people = new Set(q.userIds);
  const applicable = entries.filter((e) => e.guildId === null || e.guildId === q.guildId);
  const hits = applicable.filter((e) => {
    if (e.mode === 'constant') return true;
    if (e.target.startsWith('user:') && people.has(e.target.slice(5))) return true;
    return e.keywords.some((k) => haystack.includes(k.toLowerCase()));
  });
  hits.sort((a, b) => (a.mode === b.mode ? b.priority - a.priority : a.mode === 'constant' ? -1 : 1));

  const picked: LoreEntry[] = [];
  let used = 0;
  for (const e of hits) {
    if (used + e.content.length > budgetChars) continue;
    picked.push(e);
    used += e.content.length;
  }
  return picked;
}

/** 条目正文里的 <@ID> 渲染成 "@名字（ID …）"，让模型既知道是谁、需要时也能 @ 对方 */
export function renderLoreContent(content: string, guildId: string | null): string {
  return content.replace(/<@!?(\d{15,25})>/g, (_m, id: string) => {
    const p = personFromDb(id, guildId, null);
    return p ? `@${p.displayName}（ID ${id}）` : `@某人（ID ${id}）`;
  });
}

const TARGET_LABEL = (t: string): string => (t === 'self' ? '关于你' : t.startsWith('user:') ? '关于成员' : '服务器');

export function renderLoreBlock(picked: LoreEntry[], guildId: string | null): string | null {
  if (picked.length === 0) return null;
  const lines = picked.map((e) => `- [${TARGET_LABEL(e.target)}] ${renderLoreContent(e.content, guildId)}`);
  return `[设定集 — 服务器管理者写下的固定事实，可以放心采信]\n${lines.join('\n')}`;
}
