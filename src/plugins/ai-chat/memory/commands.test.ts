import { beforeEach, describe, expect, test } from 'bun:test';
import { upsertMember, upsertUser } from '@/plugins/ai-chat/identity';
import { isOwnMemory, renderOwnMemories } from './commands';
import { activeSlot, addMemory } from './store';
import { handleAiCommand } from '@/plugins/ai-chat/commands';
import { GUILD_ID, SELF_ID, memberInfo, setupAiTest, userInfo } from '@/testing/fixtures';
import { fakeChannel, fakeInteraction } from '@/testing/discord-fakes';

const A = '100000000000000001';
const B = '100000000000000002';

/** 以 alice 的身份执行一条 AI 斜杠命令，返回回复文本 */
async function runCommand(name: string, options: Record<string, string>): Promise<string> {
  const ch = fakeChannel({ id: SELF_ID, username: 'memecat', bot: true });
  const it = fakeInteraction(name, { id: A, username: 'alice', nickname: '阿丽' }, ch, options);
  expect(await handleAiCommand(it)).toBe(true);
  return it.replies.join('\n');
}

beforeEach(() => {
  setupAiTest();
  upsertUser(userInfo(A, 'alice'), Date.now());
  upsertMember(memberInfo(A, { nickname: '阿丽' }), userInfo(A, 'alice'), Date.now());
  upsertUser(userInfo(B, 'bob'), Date.now());
});

describe('/memory', () => {
  test('列出核心、档案、关系；敏感记忆对本人可见并标注；附带操作提示', () => {
    addMemory({ scope: 'user', subjectId: A, kind: 'preference', content: '最爱吃火锅', importance: 9, origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '最近在看心理医生', sensitive: true, origin: 'extractor' });
    addMemory({ scope: 'relation', subjectId: B, objectId: A, kind: 'relationship', content: 'bob 和阿丽是同事', origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: B, kind: 'fact', content: 'bob 的事', origin: 'extractor' });
    const { text, count } = renderOwnMemories(A, GUILD_ID);
    expect(count).toBe(3);
    expect(text).toContain('称呼：阿丽（你的服务器昵称）');
    expect(text).toContain('## 核心（每次聊天都会想起）');
    expect(text).toContain('〔敏感，只在和你聊天时使用〕');
    expect(text).toContain('## 你和别人的关系');
    expect(text).not.toContain('bob 的事');
    expect(text).toContain('/forget-me');
  });

  test('isOwnMemory：本人记忆与本人参与的关系才算', () => {
    const own = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: 'x', origin: 'tool' });
    const rel = addMemory({ scope: 'relation', subjectId: B, objectId: A, kind: 'relationship', content: 'y', origin: 'tool' });
    const other = addMemory({ scope: 'user', subjectId: B, kind: 'fact', content: 'z', origin: 'tool' });
    const guild = addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'meme', content: 'w', origin: 'tool' });
    expect([own, rel, other, guild].map((m) => isOwnMemory(m, A))).toEqual([true, true, false, false]);
  });
});

describe('/pronouns（与远端的代词功能合并）', () => {
  test('设置后出现在别人看到的档案里；留空查看；"清除"清除；别人不能替 TA 设置', async () => {
    const { identityLines } = await import('./dossier');
    const { executeTool } = await import('@/plugins/ai-chat/tools');
    const set = await runCommand('pronouns', { 代词: '她' });
    expect(set).toContain('她');
    expect(activeSlot('user', A, 'pronouns')?.value).toBe('她');
    expect(identityLines(A, GUILD_ID, true)[0]).toContain('代词：她');
    expect(await runCommand('pronouns', {})).toContain('「她」');
    const viaTool = await executeTool(
      'remember',
      JSON.stringify({ about: `<@${A}>`, kind: 'fact', slot: 'pronouns', value: '他', content: '用他' }),
      { platform: 'discord', username: 'b', userId: B, guildId: GUILD_ID, personaId: 'memecat', people: [], seenUserIds: new Set() }
    );
    expect(viaTool).toContain('本人');
    expect(await runCommand('pronouns', { 代词: '清除' })).toContain('已清除');
    expect(activeSlot('user', A, 'pronouns')).toBeNull();
  });
});
