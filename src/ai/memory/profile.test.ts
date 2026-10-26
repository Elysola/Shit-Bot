import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '../../storage';
import { upsertGuild, upsertMember, upsertUser } from '../identity';
import { ingestMessage } from '../ingest';
import { buildPersonCore } from './dossier';
import { refreshStaleStats, runRefreshProfile, scheduleProfileRefresh } from './profile';
import { getSavedUserStats } from './stats';
import { addMemory, getMemory, listMemories } from './store';
import { GUILD_ID, ingestFixture, installFakeLlm, memberInfo, setupAiTest, userInfo } from '../../testing/fixtures';

const A = '100000000000000001';
const DAY = 86400_000;
let fake: ReturnType<typeof installFakeLlm> | null = null;

beforeEach(() => {
  setupAiTest();
  upsertGuild(GUILD_ID, '测试服', Date.now());
  upsertUser(userInfo(A, 'awei'), Date.now());
  upsertMember(memberInfo(A, { nickname: '阿伟' }), userInfo(A, 'awei'), Date.now());
});

afterEach(() => {
  fake?.restore();
  fake = null;
});

function jobsOf(type: string): Array<{ payload: string }> {
  return getDatabase().query('SELECT payload FROM jobs WHERE type = ?').all(type) as Array<{ payload: string }>;
}

describe('scheduleProfileRefresh', () => {
  test('≥3 条记忆且没有画像时投递；有画像后需要 ≥5 条变化', () => {
    const now = Date.now();
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '一', origin: 'extractor' }, now);
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '二', origin: 'extractor' }, now);
    expect(scheduleProfileRefresh(now)).toBe(0);
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '三', origin: 'extractor' }, now);
    expect(scheduleProfileRefresh(now)).toBe(1);
    expect(JSON.parse(jobsOf('refresh_profile')[0].payload)).toEqual({ scope: 'user', subjectId: A });

    getDatabase().run('DELETE FROM jobs');
    getDatabase().run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, generated_at) VALUES ('user', ?, 'x', ?, ?)", [A, now, now]);
    for (let i = 0; i < 4; i++) addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: `新${i}`, origin: 'extractor' }, now + 1000);
    expect(scheduleProfileRefresh(now + 2000)).toBe(0);
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '新4', origin: 'extractor' }, now + 1000);
    expect(scheduleProfileRefresh(now + 2000)).toBe(1);
  });
});

describe('runRefreshProfile', () => {
  test('写入画像、反思特点、置顶建议；提示词不含敏感记忆；统计同时落库', async () => {
    const t = Date.now() - DAY;
    for (let i = 0; i < 25; i++) ingestMessage(ingestFixture({ authorId: A, username: 'awei', createdAt: t + i * 60_000, content: `第${i}条消息` }));
    const coffee = addMemory({ scope: 'user', subjectId: A, kind: 'preference', content: '喜欢喝咖啡', origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '在看心理医生', sensitive: true, origin: 'extractor' });
    const oldTrait = addMemory({ scope: 'user', subjectId: A, kind: 'trait', content: '旧的反思', origin: 'reflection' });
    const keptTrait = addMemory({ scope: 'user', subjectId: A, kind: 'trait', content: '被置顶的反思', origin: 'reflection', pinned: true });

    fake = installFakeLlm(() =>
      JSON.stringify({
        summary: '阿伟是群里的常客，喜欢喝咖啡。',
        traits: [{ content: '咖啡爱好者', importance: 9 }],
        pin: [coffee.id, 999999],
        unpin: [],
      })
    );
    await runRefreshProfile('user', A);

    expect(fake.calls[0].user).toContain('喜欢喝咖啡');
    expect(fake.calls[0].user).not.toContain('心理医生');
    expect(fake.calls[0].user).toContain('发言 25 条');
    expect(getDatabase().query("SELECT summary FROM profiles WHERE scope = 'user' AND subject_id = ?").get(A)).toEqual({ summary: '阿伟是群里的常客，喜欢喝咖啡。' });
    expect(getMemory(oldTrait.id)).toBeNull();
    expect(getMemory(keptTrait.id)?.content).toBe('被置顶的反思');
    const traits = listMemories({ scope: 'user', subjectId: A, kinds: ['trait'] }).map((m) => [m.content, m.importance]);
    expect(traits).toEqual(expect.arrayContaining([['咖啡爱好者', 8]]));
    expect(getMemory(coffee.id)?.pinned).toBe(1);
    expect(getSavedUserStats(A, GUILD_ID)?.messages).toBe(25);
    // 画像出现在核心档案里；刷新后不会因为自己的写入马上又被判定需要刷新
    expect(buildPersonCore(A, { guildId: GUILD_ID, viewerId: A, maxChars: 2000, detail: 'speaker' })).toContain('画像：阿伟是群里的常客');
    expect(scheduleProfileRefresh(Date.now() + 1000)).toBe(0);
  });

  test('服务器画像', async () => {
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'rule', content: '禁止刷屏', origin: 'extractor' });
    fake = installFakeLlm(() => JSON.stringify({ summary: '一个游戏群，规矩是禁止刷屏。', traits: [], pin: [], unpin: [] }));
    await runRefreshProfile('guild', GUILD_ID);
    expect(fake.calls[0].user).toContain('禁止刷屏');
    expect(getDatabase().query("SELECT summary FROM profiles WHERE scope = 'guild'").get()).toEqual({ summary: '一个游戏群，规矩是禁止刷屏。' });
  });
});

describe('refreshStaleStats', () => {
  test('只发"哈哈"的人也有统计', () => {
    const t = Date.now() - 3600_000;
    for (let i = 0; i < 3; i++) ingestMessage(ingestFixture({ authorId: A, username: 'awei', createdAt: t + i * 1000, content: '哈哈' }));
    expect(refreshStaleStats(Date.now())).toBe(1);
    expect(getSavedUserStats(A, GUILD_ID)?.messages).toBe(3);
    expect(refreshStaleStats(Date.now())).toBe(0);
  });
});

describe('画像的隐私与水位线（审查修复）', () => {
  test('画像会被别人看到：涉及敏感话题的句子和反思特点不写；生成期间别人写入的新记忆留给下一轮', async () => {
    for (const c of ['阿伟喜欢打篮球', '阿伟在杭州工作', '阿伟养了一只猫']) addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: c, origin: 'extractor' });
    let concurrent = 0;
    fake = installFakeLlm(() => {
      // 模拟生成期间有新记忆写入
      concurrent = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟换到了上海工作', origin: 'tool' }).id;
      return JSON.stringify({
        summary: '阿伟是个爱运动的程序员。他最近确诊了焦虑症。养了一只猫。',
        traits: [
          { content: '有焦虑症，需要照顾', importance: 6 },
          { content: '热爱运动', importance: 5 },
        ],
        pin: [],
        unpin: [],
      });
    });
    await runRefreshProfile('user', A);
    const row = getDatabase().query("SELECT summary, memory_watermark FROM profiles WHERE scope = 'user' AND subject_id = ?").get(A) as { summary: string; memory_watermark: number };
    expect(row.summary).toBe('阿伟是个爱运动的程序员。养了一只猫。');
    expect(listMemories({ scope: 'user', subjectId: A, kinds: ['trait'], includeSensitive: true }).map((m) => m.content)).toEqual(['热爱运动']);
    expect(getMemory(concurrent)!.updated_at).toBeGreaterThan(row.memory_watermark);
  });
});
