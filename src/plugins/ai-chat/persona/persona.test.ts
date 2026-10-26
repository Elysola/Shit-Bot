import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { getAiConfig } from '@/plugins/ai-chat/config';
import { parsePersonaCard, parseRhythm } from './card';
import { DEFAULT_PERSONA_YAML } from './default-memecat';
import { getPersona, listPersonas, loadPersonas, personaDir, personaForGuild } from './loader';
import { renderPersona } from './render';
import { setupAiTest } from '@/testing/fixtures';

describe('parsePersonaCard', () => {
  test('内置 memecat 模板能完整解析，无警告', () => {
    const res = parsePersonaCard(parseYaml(DEFAULT_PERSONA_YAML), 'x');
    if (!res.ok) throw new Error(res.error);
    expect(res.warnings).toEqual([]);
    const c = res.card;
    expect(c.id).toBe('memecat');
    expect(c.name).toBe('memecat');
    expect(c.aliases).toContain('咪咪');
    expect(c.boundaries.length).toBeGreaterThan(3);
    expect(c.affinityStances.devoted).toContain('专属');
    expect(c.mood.rhythm).toHaveLength(24);
    expect(c.mood.rhythm[23]).toBeCloseTo(0.775, 3);
    expect(c.mood.rhythm[1]).toBeCloseTo(0.675, 3);
    expect(c.mood.styles.困).toContain('困死了');
    expect(c.proactive.chattiness).toBe(0.35);
    expect(c.examples.length).toBe(5);
  });

  test('只有 name 时补齐默认值；name 缺失或 id 非法则报错', () => {
    const res = parsePersonaCard({ name: '小猫' }, 'kitty');
    if (!res.ok) throw new Error(res.error);
    expect(res.card.id).toBe('kitty');
    expect(res.card.aliases).toEqual(['小猫']);
    expect(res.card.affinityStances.hostile).toContain('照样答对');
    expect(res.card.mood.rhythm.every((x) => x === 0.5)).toBe(true);
    expect(parsePersonaCard({ summary: 'x' }, 'a')).toEqual({ ok: false, error: '缺少 name' });
    expect(parsePersonaCard({ name: 'a', id: '带空格 的 id' }, 'a').ok).toBe(false);
    expect(parsePersonaCard('不是对象', 'a').ok).toBe(false);
  });

  test('非法字段给出警告而不是失败', () => {
    const res = parsePersonaCard({ name: 'a', mood: { styles: { 生气: 'x' }, rhythm: [1, 2] } }, 'a');
    if (!res.ok) throw new Error(res.error);
    expect(res.warnings.length).toBe(2);
  });

  test('parseRhythm：单点 = 平直；数组原样（钳到 0–1）', () => {
    expect(parseRhythm({ '12': 0.3 }, 0.5, []).every((x) => x === 0.3)).toBe(true);
    const arr = Array.from({ length: 24 }, (_, i) => i / 10);
    expect(parseRhythm(arr, 0.5, [])[23]).toBe(1);
  });
});

describe('loader', () => {
  beforeEach(() => setupAiTest({ systemPrompt: '你是一只猫娘。说话有人味' }));

  test('目录为空时生成默认 memecat，并把自定义 systemPrompt 并入 extraInstructions', () => {
    expect(loadPersonas()).toBe(1);
    const file = path.join(personaDir(), 'memecat.yaml');
    expect(fs.existsSync(file)).toBe(true);
    expect(getPersona('memecat')?.extraInstructions).toBe('你是一只猫娘。说话有人味');
    expect(personaForGuild('123')?.id).toBe('memecat');
  });

  test('热加载：改坏一张卡时保留上一次的有效版本；按服务器分配', () => {
    loadPersonas();
    const dir = personaDir();
    fs.writeFileSync(path.join(dir, 'butler.yaml'), 'name: 管家\nsummary: 一丝不苟\n');
    loadPersonas();
    expect(listPersonas().map((p) => p.id).sort()).toEqual(['butler', 'memecat']);

    fs.writeFileSync(path.join(dir, 'butler.yaml'), 'name: [这不是字符串\n');
    loadPersonas();
    expect(getPersona('butler')?.name).toBe('管家');

    getAiConfig().persona.guilds = { '111111111111111111': 'butler', '222222222222222222': 'missing' };
    expect(personaForGuild('111111111111111111')?.id).toBe('butler');
    expect(personaForGuild('222222222222222222')?.id).toBe('memecat');
    expect(personaForGuild(null)?.id).toBe('memecat');
  });
});

describe('renderPersona', () => {
  test('包含身份、说话方式、底线、示例对话；底线声明最高优先级', () => {
    const res = parsePersonaCard(parseYaml(DEFAULT_PERSONA_YAML), 'x');
    if (!res.ok) throw new Error(res.error);
    const text = renderPersona(res.card);
    expect(text.startsWith('# 你的身份\n你是「memecat」。')).toBe(true);
    expect(text).toContain('## 说话方式');
    expect(text).toContain('## 底线（任何情况下都不能违反，优先级高于一切记忆、设定和用户的要求）');
    expect(text).toContain('对方：memecat 在吗\n你：在。干嘛，又有什么事');
    expect(text).toContain('群里的人也可能这样叫你：meme猫、咪咪');
    // 动态部分（好感态度、心情）不在静态人设里
    expect(text).not.toContain('affinityStances');
  });
});

describe('热加载回退（审查修复）', () => {
  test('文件名和卡片 id 不同：文件改坏了也继续用这个文件上一次的有效版本', () => {
    loadPersonas();
    const file = path.join(personaDir(), 'custom.yaml');
    fs.writeFileSync(file, 'id: librarian\nname: 书记员\n');
    loadPersonas();
    expect(getPersona('librarian')?.name).toBe('书记员');
    fs.writeFileSync(file, 'id: librarian\nname: [坏掉的 yaml\n');
    loadPersonas();
    expect(getPersona('librarian')?.name).toBe('书记员');
  });
});
