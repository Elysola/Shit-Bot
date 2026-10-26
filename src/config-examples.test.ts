import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { normalizeAiConfig } from './config';

const root = path.resolve(__dirname, '..');
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

describe('示例配置', () => {
  // groups 段三份示例本来就各举了不同的例子，这里只比较 ai 与 discord
  test('YAML / JSON / TOML 三份的 ai、discord 段完全一致', () => {
    for (const key of ['ai', 'discord']) {
      expect(examples.json[key]).toEqual(examples.yaml[key]);
      expect(examples.toml[key]).toEqual(examples.yaml[key]);
    }
  });

  test('ai 段的值就是代码里的默认值（只是把记忆打开了），且没有拼错或废弃的字段', () => {
    const ai = examples.yaml.ai;
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
