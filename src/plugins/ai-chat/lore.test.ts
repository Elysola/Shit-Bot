import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { upsertMember, upsertUser } from './identity';
import { loadLore, loreDir, renderLoreBlock, selectLore } from './lore';
import { GUILD_ID, memberInfo, setupAiTest, userInfo } from '@/testing/fixtures';

const OWNER = '100000000000000007';

beforeEach(() => {
  setupAiTest();
  fs.writeFileSync(
    path.join(loreDir(), 'global.yaml'),
    'entries:\n  - id: g1\n    content: 所有服务器通用的设定\n'
  );
  fs.writeFileSync(
    path.join(loreDir(), `${GUILD_ID}.yaml`),
    [
      'entries:',
      '  - id: owner',
      '    priority: 10',
      `    content: 群主是 <@${OWNER}>，大家叫他老王`,
      '  - id: genshin',
      '    keywords: [原神, 深渊]',
      '    content: 群里有个原神小分队，每周六晚上打深渊',
      `  - id: wang`,
      `    target: user:${OWNER}`,
      '    mode: keywords',
      '    keywords: [从不出现的词]',
      '    content: 老王是猫奴',
      '  - id: empty',
      '    content: ""',
    ].join('\n')
  );
  fs.writeFileSync(path.join(loreDir(), 'notes.yaml'), 'entries: []\n');
});

describe('lorebook', () => {
  test('加载：服务器文件 + global；忽略非法文件名与空条目', () => {
    expect(loadLore()).toBe(4);
  });

  test('常驻条目总在；关键词命中才带；目标成员被涉及时触发；其它服务器只拿到 global', () => {
    loadLore();
    const ids = (q: Parameters<typeof selectLore>[0], budget = 5000) => selectLore(q, budget).map((e) => e.id);
    expect(ids({ guildId: GUILD_ID, texts: ['今天吃什么'], userIds: [] })).toEqual(['owner', 'g1']);
    expect(ids({ guildId: GUILD_ID, texts: ['周六打不打深渊'], userIds: [] })).toEqual(['owner', 'g1', 'genshin']);
    expect(ids({ guildId: GUILD_ID, texts: [''], userIds: [OWNER] })).toEqual(['owner', 'g1', 'wang']);
    expect(ids({ guildId: '800000000000000999', texts: ['原神'], userIds: [] })).toEqual(['g1']);
    // 预算按原文长度计：owner（30 字，优先级高）先放，剩下的放不下就跳过
    expect(ids({ guildId: GUILD_ID, texts: ['原神'], userIds: [] }, 35)).toEqual(['owner']);
  });

  test('渲染：<@ID> 变成 "@名字（ID …）"', () => {
    loadLore();
    upsertUser(userInfo(OWNER, 'laowang'), Date.now());
    upsertMember(memberInfo(OWNER, { nickname: '王总' }), userInfo(OWNER, 'laowang'), Date.now());
    const block = renderLoreBlock(selectLore({ guildId: GUILD_ID, texts: [], userIds: [] }, 5000), GUILD_ID)!;
    expect(block).toContain(`- [服务器] 群主是 @王总（ID ${OWNER}），大家叫他老王`);
    expect(block.startsWith('[设定集')).toBe(true);
  });
});

describe('热加载（审查修复）', () => {
  test('文件改坏了：这个文件继续用上一次解析成功的条目，群规不会突然消失', () => {
    fs.writeFileSync(path.join(loreDir(), 'global.yaml'), 'entries:\n  - id: rules\n    mode: constant\n    content: 群规：不许刷屏\n');
    loadLore();
    const before = selectLore({ guildId: null, texts: [''], userIds: [] }, 5000).map((e) => e.id);
    expect(before).toContain('rules');
    fs.writeFileSync(path.join(loreDir(), 'global.yaml'), 'entries:\n  - id: rules\n    content: [坏掉的 yaml\n');
    loadLore();
    expect(selectLore({ guildId: null, texts: [''], userIds: [] }, 5000).map((e) => e.id)).toContain('rules');
  });
});
