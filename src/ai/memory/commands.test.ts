import { beforeEach, describe, expect, test } from 'bun:test';
import { upsertMember, upsertUser } from '../identity';
import { isOwnMemory, renderOwnMemories } from './commands';
import { addMemory } from './store';
import { GUILD_ID, memberInfo, setupAiTest, userInfo } from '../../testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';

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
