import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { getAiConfig } from '@/plugins/ai-chat/config';
import { resolveProjectPath } from '@/storage';
import { parsePersonaCard, type PersonaCard } from './card';
import { DEFAULT_PERSONA_ID, DEFAULT_PERSONA_YAML } from './default-memecat';

const DEFAULT_SYSTEM_PROMPT = '你是一个有帮助的助手。';
const PERSONA_EXT = /\.(ya?ml|json)$/i;

let personas = new Map<string, PersonaCard>();
// 每个文件最近一次解析成功的人设卡（文件改坏时回退用；按文件而不是按 id，因为文件名和 id 可以不同）
const lastGoodByFile = new Map<string, PersonaCard>();
let loadedDir: string | null = null;
let watcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

export function personaDir(): string {
  return resolveProjectPath(getAiConfig().persona.dir);
}

function parseFile(file: string): unknown {
  const raw = fs.readFileSync(file, 'utf-8');
  return /\.json$/i.test(file) ? JSON.parse(raw) : parseYaml(raw);
}

/** 目录里一张人设卡都没有时，写出内置的 memecat 模板；用户自定义过的 systemPrompt 并入 extraInstructions */
function writeDefaultPersona(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  let content = DEFAULT_PERSONA_YAML;
  const prompt = getAiConfig().systemPrompt?.trim();
  if (prompt && prompt !== DEFAULT_SYSTEM_PROMPT) {
    const indented = prompt
      .split(/\r?\n/)
      .map((l) => `  ${l}`)
      .join('\n');
    content += `\n# 由旧配置 ai.systemPrompt 迁移而来\nextraInstructions: |\n${indented}\n`;
  }
  const file = path.join(dir, `${DEFAULT_PERSONA_ID}.yaml`);
  fs.writeFileSync(file, content, 'utf-8');
  console.log(`[Persona] 已生成默认人设卡: ${file}`);
}

/**
 * （重新）加载人设卡目录。单张卡解析失败时保留它上一次的有效版本并告警，不影响其它卡。
 * 返回当前可用的人设卡数量。
 */
export function loadPersonas(): number {
  const dir = personaDir();
  const dirChanged = loadedDir !== dir;
  if (dirChanged) personas = new Map();
  loadedDir = dir;

  let files: string[] = [];
  try {
    files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => PERSONA_EXT.test(f)) : [];
    if (files.length === 0) {
      writeDefaultPersona(dir);
      files = fs.readdirSync(dir).filter((f) => PERSONA_EXT.test(f));
    }
  } catch (e) {
    console.warn(`[Persona] 读取人设卡目录失败 (${dir}):`, (e as Error).message);
  }

  const next = new Map<string, PersonaCard>();
  for (const f of files) {
    const fallbackId = f.replace(PERSONA_EXT, '');
    let result;
    try {
      result = parsePersonaCard(parseFile(path.join(dir, f)), fallbackId);
    } catch (e) {
      result = { ok: false as const, error: (e as Error).message };
    }
    const file = path.join(dir, f);
    if (!result.ok) {
      const prev = lastGoodByFile.get(file);
      console.warn(`[Persona] 人设卡 ${f} 无效：${result.error}${prev ? '，继续使用上一次的有效版本' : ''}`);
      if (prev && !next.has(prev.id)) next.set(prev.id, prev);
      continue;
    }
    lastGoodByFile.set(file, result.card);
    for (const w of result.warnings) console.warn(`[Persona] ${f}: ${w}`);
    if (next.has(result.card.id)) {
      console.warn(`[Persona] 人设卡 id "${result.card.id}" 重复（${f}），已忽略`);
      continue;
    }
    next.set(result.card.id, result.card);
  }
  personas = next;
  return personas.size;
}

/** 监听人设卡目录，改动后 500ms 防抖重新加载 */
export function watchPersonas(): void {
  if (watcher) return;
  const dir = personaDir();
  try {
    watcher = fs.watch(dir, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        const n = loadPersonas();
        console.log(`[Persona] 人设卡已重新加载（${n} 张）`);
      }, 500);
    });
    watcher.on('error', (e) => console.warn('[Persona] 监听人设卡目录出错:', e.message));
  } catch (e) {
    console.warn(`[Persona] 无法监听人设卡目录 (${dir})，修改后需重启生效:`, (e as Error).message);
  }
}

export function stopWatchingPersonas(): void {
  watcher?.close();
  watcher = null;
}

function ensureLoaded(): void {
  if (loadedDir !== personaDir()) loadPersonas();
}

export function getPersona(id: string): PersonaCard | null {
  ensureLoaded();
  return personas.get(id) ?? null;
}

export function listPersonas(): PersonaCard[] {
  ensureLoaded();
  return [...personas.values()];
}

/** 某个服务器该用哪张人设卡：服务器专属分配 → 默认 → 任意一张；都没有时返回 null（回退到 systemPrompt） */
export function personaForGuild(guildId: string | null | undefined): PersonaCard | null {
  ensureLoaded();
  const cfg = getAiConfig().persona;
  const assigned = guildId ? cfg.guilds[guildId] : undefined;
  if (assigned) {
    const p = personas.get(assigned);
    if (p) return p;
    console.warn(`[Persona] 服务器 ${guildId} 分配的人设卡 "${assigned}" 不存在，改用默认`);
  }
  return personas.get(cfg.default) ?? personas.values().next().value ?? null;
}
