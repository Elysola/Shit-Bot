import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { normalizeAiConfig } from './config';

const root = path.resolve(__dirname, '../../..');
const read = (name: string): string => fs.readFileSync(path.join(root, name), 'utf-8');
const examples = {
  yaml: parseYaml(read('config.example.yaml')) as Record<string, unknown>,
  json: JSON.parse(read('config.example.json')) as Record<string, unknown>,
  toml: parseToml(read('config.example.toml')) as Record<string, unknown>,
};

/** 所有叶子路径（数组算叶子） */
function leafPaths(v: unknown, prefix = ''): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [prefix];
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([k, x]) => leafPaths(x, prefix ? `${prefix}.${k}` : k));
}

function has(obj: unknown, dotted: string): boolean {
  let cur: unknown = obj;
  for (const k of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !(k in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}

/** plugins[ai-chat] 条目 */
function aiPlugin(cfg: Record<string, unknown>): Record<string, unknown> | undefined {
  const list = Array.isArray(cfg.plugins) ? (cfg.plugins as Array<Record<string, unknown>>) : [];
  return list.find((p) => p.name === 'ai-chat');
}

describe('示例配置', () => {
  // groups、其它插件三份示例本来就各举了不同的例子，这里只比较 AI 插件与 discord
  test('YAML / JSON / TOML 三份的 AI 插件配置、discord 段完全一致', () => {
    expect(aiPlugin(examples.yaml)).toBeDefined();
    expect(aiPlugin(examples.json)).toEqual(aiPlugin(examples.yaml));
    expect(aiPlugin(examples.toml)).toEqual(aiPlugin(examples.yaml));
    expect(examples.json.discord).toEqual(examples.yaml.discord);
    expect(examples.toml.discord).toEqual(examples.yaml.discord);
    // 旧的顶层 ai: 不再出现在示例里
    for (const ex of Object.values(examples)) expect(ex.ai).toBeUndefined();
  });

  test('AI 插件的选项就是代码里的默认值（只是把记忆打开了），且没有拼错或废弃的字段', () => {
    const ai = aiPlugin(examples.yaml)!.options;
    expect(normalizeAiConfig(ai)).toEqual(normalizeAiConfig({ memory: { enabled: true } }));
    const normalized = normalizeAiConfig(ai);
    const unknown = leafPaths(ai).filter((p) => !has(normalized, p));
    expect(unknown).toEqual([]);
    for (const key of ['maxProfileItems', 'maxProfileChars', 'recentTurns', 'recallLimit', 'logConversations', 'maxConversationsPerUser']) {
      expect(has(ai, `memory.${key}`)).toBe(false);
    }
  });

  test('Discord 特权 intent 默认自动检测', () => {
    expect((examples.yaml.discord as Record<string, unknown>).privilegedIntents).toEqual({ members: 'auto', presences: 'auto' });
  });
});
