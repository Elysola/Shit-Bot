import { beforeEach, describe, expect, test } from 'bun:test';
import { setMeta } from '@/plugins/ai-chat/db/meta';
import { upsertGuild, upsertMember, upsertUser } from '@/plugins/ai-chat/identity';
import { addressOf, buildGuildCore, buildPersonCore, buildSelfCore, fitToBudget, identityLines } from './dossier';
import { addMemory } from './store';
import { GUILD_ID, SELF_ID, memberInfo, setupAiTest, userInfo } from '@/testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';
const DAY = 86400000;

beforeEach(() => {
  setupAiTest();
  const now = Date.now();
  upsertGuild(GUILD_ID, '测试服', now);
  upsertUser(userInfo(A, 'wei_2000', { globalName: 'Wei' }), now);
  upsertMember(memberInfo(A, { nickname: '伟哥', roles: [{ id: '1', name: '管理员' }], joinedAt: Date.UTC(2024, 5, 1) }), userInfo(A, 'wei_2000', { globalName: 'Wei' }), now);
  upsertUser(userInfo(B, 'xiaohong'), now);
  upsertMember(memberInfo(B, { nickname: '小红' }), userInfo(B, 'xiaohong'), now);
});

describe('称呼', () => {
  test('优先级：本人要求 > 服务器昵称 > 显示名 > 用户名；外号记录是谁叫的', () => {
    expect(addressOf(A, GUILD_ID)).toMatchObject({ address: '伟哥', source: 'nickname' });
    expect(addressOf(A, null)).toMatchObject({ address: 'Wei', source: 'global' });
    addMemory({ scope: 'user', subjectId: A, kind: 'alias', value: '老王', content: '小红叫阿伟"老王"', origin: 'extractor', sourceUserId: B });
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'preferred_name', value: '阿伟', content: '希望被称呼为「阿伟」', origin: 'user', sourceUserId: A });
    expect(addressOf(A, GUILD_ID)).toEqual({ address: '阿伟', source: 'preferred', aliases: [{ value: '老王', by: '小红' }] });
  });

  test('身份行包含 ID、用户名、显示名、角色、入群时间', () => {
    const lines = identityLines(A, GUILD_ID);
    expect(lines[0]).toBe('@伟哥 ｜ 称呼：伟哥（服务器昵称）');
    expect(lines[1]).toBe(`  ID ${A} ｜ 用户名 wei_2000 ｜ 显示名 Wei`);
    expect(lines[2]).toContain('入群 2024-06');
    expect(lines[2]).toContain('角色：管理员');
  });
});

describe('buildPersonCore', () => {
  test('说话人：slot、置顶、近期动态、目录；敏感记忆只给本人看', () => {
    const now = Date.now();
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'occupation', value: '前端', content: '在杭州做前端', origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: A, kind: 'preference', content: '最爱吃火锅', importance: 9, origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: A, kind: 'plan', content: '下周三考六级', eventAt: now + 3 * DAY, validUntil: now + 4 * DAY, origin: 'extractor' });
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '最近在看心理医生', importance: 9, sensitive: true, origin: 'extractor' });

    const self = buildPersonCore(A, { guildId: GUILD_ID, viewerId: A, maxChars: 2000, detail: 'speaker', now });
    expect(self).toContain('- 职业：前端');
    expect(self).toContain('最爱吃火锅');
    expect(self).toContain('近期动态：');
    expect(self).toContain('下周三考六级');
    expect(self).toContain('心理医生');
    expect(self).toMatch(/档案里关于TA共有 4 条记忆/);

    const other = buildPersonCore(A, { guildId: GUILD_ID, viewerId: B, maxChars: 2000, detail: 'speaker', now });
    expect(other).not.toContain('心理医生');
    expect(other).toMatch(/共有 3 条记忆/);
  });

  test('预算很小时丢弃靠后的行，但目录行总在', () => {
    for (let i = 0; i < 10; i++) addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: `置顶事实 ${i} ${'很长'.repeat(20)}`, importance: 9, origin: 'extractor' });
    const core = buildPersonCore(A, { guildId: GUILD_ID, viewerId: A, maxChars: 400, detail: 'speaker' });
    expect(core.length).toBeLessThanOrEqual(400 + 200);
    expect(core.split('\n').pop()).toMatch(/^（档案里关于TA共有/);
  });

  test('被提到的人：精简身份 + 与说话人的关系', () => {
    addMemory({ scope: 'relation', subjectId: A, objectId: B, kind: 'relationship', content: '阿伟和小红是大学同学', origin: 'extractor' });
    const core = buildPersonCore(B, { guildId: GUILD_ID, viewerId: A, maxChars: 800, detail: 'mentioned', speakerId: A });
    expect(core.startsWith('[核心档案：本条消息提到的人]\n@小红')).toBe(true);
    expect(core).toContain('和说话人的关系：阿伟和小红是大学同学');
  });

  test('fitToBudget 按行丢弃', () => {
    expect(fitToBudget('H', [['aaaa', 'bbbb'], ['cccc']], 'T', 12)).toBe('H\naaaa\nT');
  });
});

describe('服务器与自我档案', () => {
  test('服务器：置顶 lore + 最近片段；没有任何内容时为 null', () => {
    expect(buildGuildCore(GUILD_ID, 1000)).toBeNull();
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'meme', content: '迟到叫"阿伟时间"', importance: 9, origin: 'extractor' });
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'episode', content: '大家在聊周末去哪玩', origin: 'extractor' });
    const core = buildGuildCore(GUILD_ID, 1000)!;
    expect(core).toContain('[核心档案：本服务器「测试服」]');
    expect(core).toContain('[梗] 迟到叫"阿伟时间"');
    expect(core).toContain('最近群里聊过：');
  });

  test('自我：账号、群里对你的叫法、心情行、置顶自我记忆', () => {
    setMeta('bot.user_id', SELF_ID);
    upsertUser(userInfo(SELF_ID, 'memecat', { isBot: true }), Date.now(), { isSelf: true });
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'bot_alias', value: '咪咪', content: '大家叫 bot 咪咪', origin: 'extractor' });
    addMemory({ scope: 'self', subjectId: 'memecat', kind: 'preference', content: '最喜欢下雨天', importance: 9, origin: 'appraisal' });
    const core = buildSelfCore({ personaId: 'memecat', personaName: 'memecat', guildId: GUILD_ID, maxChars: 800, moodLines: ['你现在有点困'] })!;
    expect(core).toContain(`你的 Discord 账号：memecat（ID ${SELF_ID}）`);
    expect(core).toContain('群里的人这样叫你：咪咪');
    expect(core).toContain('你现在有点困');
    expect(core).toContain('最喜欢下雨天');
  });
});

describe('敏感称呼（审查修复）', () => {
  test('标为敏感的外号 / 称呼只给本人看，别人看到的档案和画像输入里没有', () => {
    const A = '100000000000000001';
    upsertUser(userInfo(A, 'awei'), Date.now());
    addMemory({ scope: 'user', subjectId: A, kind: 'alias', value: '病号', content: '因为抑郁症被叫作病号', sensitive: true, origin: 'tool' });
    addMemory({ scope: 'user', subjectId: A, kind: 'alias', value: '伟哥', content: '大家叫他伟哥', origin: 'extractor' });
    expect(addressOf(A, GUILD_ID).aliases.map((a) => a.value)).toEqual(['伟哥']);
    expect(addressOf(A, GUILD_ID, { includeSensitive: true }).aliases.map((a) => a.value).sort()).toEqual(['伟哥', '病号']);
    expect(identityLines(A, GUILD_ID).join('\n')).not.toContain('病号');
    expect(identityLines(A, GUILD_ID, false, true).join('\n')).toContain('病号');
  });
});
