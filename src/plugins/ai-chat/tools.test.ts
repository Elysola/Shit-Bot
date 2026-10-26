import { beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '@/storage';
import { resolveUserRef, setOptOut, upsertGuild, upsertMember, upsertUser } from './identity';
import { ingestMessage } from './ingest';
import { addMemory, getMemory, listMemories } from '@/plugins/ai-chat/memory/store';
import { buildTools, executeTool, parseDateArg, type ToolContext } from './tools';
import { getAiConfig } from './config';
import { bumpForgetEpoch, forgetEpoch } from './forget-guard';
import { CHANNEL_ID, GUILD_ID, ingestFixture, memberInfo, setupAiTest, userInfo } from '@/testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    platform: 'discord',
    username: 'alice',
    userId: A,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    personaId: 'memecat',
    people: [],
    seenUserIds: new Set(),
    ...extra,
  };
}

const run = (name: string, args: Record<string, unknown>, c: ToolContext = ctx()): Promise<string> => executeTool(name, JSON.stringify(args), c);

beforeEach(() => {
  setupAiTest({ summary: { enabled: true } });
  const now = Date.now();
  upsertGuild(GUILD_ID, '测试服', now);
  for (const [id, username, nick] of [
    [A, 'alice', '阿丽'],
    [B, 'bob', '小B'],
    [C, 'carol', '小B'],
  ] as const) {
    upsertUser(userInfo(id, username), now);
    upsertMember(memberInfo(id, { nickname: nick }), userInfo(id, username), now);
  }
});

describe('buildTools', () => {
  test('记忆关闭时只有通用工具；开启后加上全量查询与读写工具', () => {
    expect(buildTools({ memory: false }).map((t) => t.function.name)).toEqual(['read_image', 'read_channel_history']);
    const names = buildTools({ memory: true }).map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_memory', 'get_person', 'get_relations', 'read_person_messages', 'search_messages', 'list_members', 'remember', 'revise_memory', 'forget_memory', 'pin_memory', 'unpin_memory'])
    );
  });
});

describe('resolveUserRef', () => {
  const rc = { guildId: GUILD_ID, speakerId: A, people: [] };
  test('ID / <@ID> / 我 / 昵称 / 用户名；重名返回候选', () => {
    expect(resolveUserRef(`<@${B}>`, rc)).toEqual({ ok: true, userId: B });
    expect(resolveUserRef('我', rc)).toEqual({ ok: true, userId: A });
    expect(resolveUserRef('@阿丽', rc)).toEqual({ ok: true, userId: A });
    expect(resolveUserRef('carol', rc)).toEqual({ ok: true, userId: C });
    const amb = resolveUserRef('小B', rc);
    expect(amb.ok).toBe(false);
    if (!amb.ok) expect(amb.candidates.map((c) => c.id).sort()).toEqual([B, C]);
    expect(resolveUserRef('不存在的人', rc)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(resolveUserRef('ali', rc)).toEqual({ ok: true, userId: A }); // 模糊匹配唯一
  });
});

describe('记忆工具', () => {
  test('search_memory：结果带 #id 与类型，并记录出现过的人', async () => {
    const m = addMemory({ scope: 'user', subjectId: B, kind: 'preference', content: 'bob 养了一只叫豆豆的橘猫', origin: 'extractor' });
    const c = ctx();
    const out = await run('search_memory', { query: '橘猫', about: 'bob' }, c);
    expect(out).toContain(`#${m.id} [偏好] bob 养了一只叫豆豆的橘猫`);
    expect(c.seenUserIds.has(B)).toBe(true);
    expect(await run('search_memory', { about: '小B' })).toContain('可能指以下几个人');
  });

  test('remember：默认关于说话人；关于别人时降低置信度并标注来源；拒绝隐私与替别人设称呼', async () => {
    expect(await run('remember', { content: '喜欢爬山', kind: 'habit' })).toMatch(/^已记住 #\d+/);
    expect(listMemories({ scope: 'user', subjectId: A })[0]).toMatchObject({ content: '喜欢爬山', origin: 'tool', source_user_id: A });

    await run('remember', { about: 'bob', content: 'bob 下个月结婚', kind: 'event' });
    expect(listMemories({ scope: 'user', subjectId: B })[0]).toMatchObject({ confidence: 0.6, source_user_id: A });

    expect(await run('remember', { content: '我的密码是 abc12345', kind: 'fact' })).toContain('不能记');
    expect(await run('remember', { about: 'bob', content: 'bob 有抑郁症', kind: 'fact' })).toContain('敏感隐私');
    expect(await run('remember', { about: 'bob', content: '叫他鲍勃', kind: 'fact', slot: 'preferred_name', value: '鲍勃' })).toContain('本人');
    expect(await run('remember', { about: 'guild', content: '每周五是电影夜', kind: 'event' })).toMatch(/^已记住/);
    expect(await run('remember', { about: 'guild', content: 'x', kind: 'habit' })).toContain('不适用');
  });

  test('revise / forget / pin 只能操作说话人、本服务器、自己的记忆', async () => {
    const mine = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '住在北京', origin: 'extractor' });
    const theirs = addMemory({ scope: 'user', subjectId: B, kind: 'fact', content: 'bob 住在上海', origin: 'extractor' });
    expect(await run('revise_memory', { id: mine.id, content: '搬到了上海' })).toBe(`已更新 #${mine.id}。`);
    expect(getMemory(mine.id)?.content).toBe('搬到了上海');
    expect(await run('revise_memory', { id: theirs.id, content: 'x' })).toContain('不能修改');
    expect(await run('pin_memory', { id: mine.id })).toBe(`已置顶 #${mine.id}。`);
    expect(getMemory(mine.id)?.pinned).toBe(1);
    expect(await run('forget_memory', { id: theirs.id })).toContain('不能修改');
    expect(await run('forget_memory', { id: mine.id })).toBe(`已删除 #${mine.id}。`);
    expect(await run('forget_memory', { id: 99999 })).toContain('没有找到');
  });

  test('get_person：完整档案 + 活跃统计', async () => {
    const t = Date.now() - 3600_000;
    for (let i = 0; i < 3; i++) ingestMessage(ingestFixture({ authorId: B, username: 'bob', createdAt: t + i * 1000, content: `大家好 ${i}` }));
    addMemory({ scope: 'user', subjectId: B, kind: 'fact', slot: 'occupation', value: '厨师', content: '是一名厨师', origin: 'extractor' });
    const out = await run('get_person', { user: 'bob' });
    expect(out).toContain('[完整档案：小B]');
    expect(out).toContain('- 职业：厨师');
    expect(out).toContain('发言 3 条');
  });
});

describe('消息工具', () => {
  beforeEach(() => {
    const t = Date.now() - 86400_000;
    ingestMessage(ingestFixture({ authorId: B, username: 'bob', createdAt: t, content: '周末去爬山吗' }));
    ingestMessage(ingestFixture({ authorId: A, username: 'alice', createdAt: t + 1000, content: '好呀，去西湖边' }));
    ingestMessage(ingestFixture({ authorId: B, username: 'bob', createdAt: t + 2000, content: '那就周六早上八点' }));
    // 另一个服务器里 bob 的发言
    ingestMessage(
      ingestFixture({
        authorId: B,
        username: 'bob',
        guildId: '800000000000000099',
        channel: { channelId: '700000000000000099', guildId: '800000000000000099', parentId: null, name: '别处', type: 'text' },
        createdAt: t + 3000,
        content: '另一个服务器的秘密',
      })
    );
  });

  test('read_person_messages：默认只看当前服务器；开启跨服后能看到全部', async () => {
    const out = await run('read_person_messages', { user: 'bob' });
    expect(out).toContain('那就周六早上八点');
    expect(out).not.toContain('另一个服务器的秘密');
    getAiConfig().memory.observe.crossGuildMessages = true;
    const all = await run('read_person_messages', { user: 'bob' }, ctx({ canQuoteChannel: () => true }));
    expect(all).toContain('另一个服务器的秘密');
    expect(all).toContain('#别处');
  });

  test('search_messages：全文检索带消息 ID；list_members 列出成员', async () => {
    const out = await run('search_messages', { query: '爬山' });
    expect(out).toMatch(/小B: 周末去爬山吗 ⟨\d+⟩/);
    expect(out).not.toContain('秘密');
    const members = await run('list_members', {});
    expect(members).toContain(`阿丽（@alice，ID ${A}）`);
  });

  test('read_channel_history：around 读前后文；before 往前翻', async () => {
    const pivot = (await run('search_messages', { query: '西湖' })).match(/⟨(\d+)⟩/)![1];
    const around = await run('read_channel_history', { around: pivot, count: 4 });
    expect(around).toContain('周末去爬山吗');
    expect(around).toContain('那就周六早上八点');
    const before = await run('read_channel_history', { before: pivot });
    expect(before).toContain('周末去爬山吗');
    expect(before).not.toContain('那就周六');
  });
});

describe('parseDateArg', () => {
  test('日期按 UTC+8 解析；支持 N天前', () => {
    expect(parseDateArg('2026-10-24')).toBe(Date.UTC(2026, 9, 23, 16, 0));
    expect(parseDateArg('2026-10-24', true)).toBe(Date.UTC(2026, 9, 24, 15, 59, 59));
    expect(Math.abs(parseDateArg('3天前')! - (Date.now() - 3 * 86400000))).toBeLessThan(1000);
    expect(parseDateArg('明天')).toBeUndefined();
  });
});

describe('权限与隐私（审查修复）', () => {
  test('默认不能跨服务器读原话：别的服务器的频道 ID、消息 ID 都读不到', async () => {
    const OTHER_GUILD = '800000000000000099';
    const OTHER_CH = '700000000000000099';
    const secret = ingestFixture({
      authorId: B,
      username: 'bob',
      guildId: OTHER_GUILD,
      channel: { channelId: OTHER_CH, guildId: OTHER_GUILD, parentId: null, name: '别的服', type: 'text' },
      content: '别的服务器里的悄悄话',
    });
    ingestMessage(secret);
    expect(await run('read_channel_history', { channel: OTHER_CH })).toContain('没有找到频道');
    expect(await run('read_channel_history', { around: secret.messageId })).toContain('没有找到消息');
  });

  test('remember 不给 /optout 的人记新事；revise_memory 改成敏感内容时打上敏感标记，别人的、服务器的不行', async () => {
    setOptOut(B, true);
    expect(await run('remember', { about: B, kind: 'fact', content: '小B 最近在学吉他' })).toContain('不被记录');
    const mine = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿丽喜欢喝咖啡', origin: 'extractor' });
    expect(await run('revise_memory', { id: mine.id, content: '阿丽喜欢喝咖啡，最近确诊了焦虑症' })).toContain('已更新');
    expect(getMemory(mine.id)?.sensitive).toBe(1);
    const guild = addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'topic', content: '群里在聊咖啡', origin: 'extractor' });
    expect(await run('revise_memory', { id: guild.id, content: '群里在聊阿丽确诊抑郁症的事' })).toContain('只能记在本人自己的档案里');
    // 取值字段同样过隐私检查
    expect(await run('remember', { kind: 'alias', value: '13812345678', content: '阿丽的新外号' })).toContain('不能记');
  });
});

describe('聊天期间的删除（审查修复）', () => {
  test('本轮开始后有人删除了数据：写记忆的工具拒绝；本轮自己删的旧记忆不算，"先删旧的、再记新的"照常', async () => {
    const c = ctx({ forgetEpoch: forgetEpoch() });
    const old = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'location', value: '杭州', content: '住在杭州', origin: 'extractor' });
    expect(await run('forget_memory', { id: old.id }, c)).toContain('已删除');
    expect(await run('remember', { kind: 'fact', slot: 'location', value: '上海', content: '搬到了上海' }, c)).toContain('已记住');
    // 别处的删除（比如别人 /forget-me）发生在本轮期间
    bumpForgetEpoch();
    expect(await run('remember', { kind: 'fact', content: '喜欢喝茶' }, c)).toContain('先不修改记忆');
  });
});

describe('删除代次不能被本轮的删除掩盖（审查修复）', () => {
  test('外部删除发生后，先删一条自己的记忆再 remember：仍然拒绝', async () => {
    const c = ctx({ forgetEpoch: forgetEpoch() });
    bumpForgetEpoch();
    const mine = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '喜欢猫', origin: 'extractor' });
    expect(await run('forget_memory', { id: mine.id }, c)).toContain('已删除');
    expect(await run('remember', { kind: 'fact', content: '喜欢狗' }, c)).toContain('先不修改记忆');
  });

  test('性别、感情状况只能本人说，并标为敏感', async () => {
    expect(await run('remember', { about: B, kind: 'fact', slot: 'relationship_status', value: '已婚', content: '小B已婚' })).toContain('只有本人说才能记');
    expect(await run('remember', { kind: 'fact', slot: 'relationship_status', value: '单身', content: '阿丽单身' })).toContain('已记住');
    expect(listMemories({ scope: 'user', subjectId: A, includeSensitive: true }).find((m) => m.slot === 'relationship_status')?.sensitive).toBe(1);
  });
});

describe('第 5 轮审查修复', () => {
  test('敏感外号不能用来反查是谁（本人自己可以）', async () => {
    addMemory({ scope: 'user', subjectId: B, kind: 'alias', value: '糖友', content: '因为糖尿病被叫作糖友', sensitive: true, origin: 'tool' });
    expect(resolveUserRef('糖友', { guildId: GUILD_ID, speakerId: A, people: [] }).ok).toBe(false);
    expect(resolveUserRef('糖友', { guildId: GUILD_ID, speakerId: B, people: [] })).toEqual({ ok: true, userId: B });
  });

  test('改 slot 记忆的内容必须同时给新的取值，两者一起更新', async () => {
    const loc = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'location', value: '杭州', content: '住在杭州', origin: 'extractor' });
    expect(await run('revise_memory', { id: loc.id, content: '已经搬到上海' })).toContain('请同时给出新的 content 和 value');
    // 只改取值同样不行（正文还写着旧的）
    expect(await run('revise_memory', { id: loc.id, value: '上海' })).toContain('请同时给出新的 content 和 value');
    expect(await run('revise_memory', { id: loc.id, content: '已经搬到上海', value: '上海' })).toContain('已更新');
    expect(getMemory(loc.id)).toMatchObject({ content: '已经搬到上海', value: '上海' });
  });
});

describe('第 6 轮审查修复', () => {
  test('revise_memory 只改取值也做敏感判断：打上敏感标记（只在和本人聊天时使用）', async () => {
    const own = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'preferred_name', value: '阿伟', content: '希望被叫作阿伟', origin: 'user' });
    expect(await run('revise_memory', { id: own.id, content: '希望换个新称呼', value: '抑郁症患者' })).toContain('已更新');
    expect(getMemory(own.id)).toMatchObject({ value: '抑郁症患者', sensitive: 1 });
  });
});

describe('第 8 轮审查修复', () => {
  test('remember：模型标了 sensitive 的（关键词没命中）照样按敏感处理；关于别人的拒绝', async () => {
    expect(await run('remember', { about: 'speaker', kind: 'fact', content: '阿伟对花粉严重过敏', sensitive: true })).toContain('已记住');
    expect(listMemories({ scope: 'user', subjectId: A, includeSensitive: true, limit: 10 }).find((m) => m.content.includes('花粉'))?.sensitive).toBe(1);
    expect(await run('remember', { about: 'bob', kind: 'fact', content: 'bob 对花粉严重过敏', sensitive: true })).toContain('只有本人说才能记');
    // 常见疾病名关键词兜底
    expect(await run('remember', { about: 'speaker', kind: 'fact', content: '阿伟患有糖尿病' })).toContain('已记住');
    expect(listMemories({ scope: 'user', subjectId: A, includeSensitive: true, limit: 10 }).find((m) => m.content.includes('糖尿病'))?.sensitive).toBe(1);
  });

  test('revise_memory：模型标了 sensitive 时打上敏感标记', async () => {
    const m = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟最近身体不太好', origin: 'extractor' });
    expect(await run('revise_memory', { id: m.id, content: '阿伟查出了花粉过敏', sensitive: true })).toContain('已更新');
    expect(getMemory(m.id)?.sensitive).toBe(1);
  });
});

describe('读原话的频道权限（审查修复，第 9 轮）', () => {
  const ADMIN = '700000000000000050';
  beforeEach(() => {
    const t = Date.now() - 86400_000;
    ingestMessage(ingestFixture({ authorId: B, username: 'bob', createdAt: t, content: '公开频道里的闲聊' }));
    ingestMessage(
      ingestFixture({
        authorId: B,
        username: 'bob',
        channel: { channelId: ADMIN, guildId: GUILD_ID, parentId: null, name: '管理组', type: 'text' },
        createdAt: t + 1000,
        content: '下周封禁捣乱的人',
      })
    );
  });

  test('不能在这里转述的频道：按名字 / ID 读、按人读、全文搜都拿不到；能转述的照常', async () => {
    const deny = ctx({ canQuoteChannel: (id) => id !== ADMIN });
    expect(await run('read_channel_history', { channel: '管理组' }, deny)).toContain('不能在这里转述');
    expect(await run('read_channel_history', { channel: `<#${ADMIN}>` }, deny)).toContain('不能在这里转述');
    expect(await run('read_person_messages', { user: 'bob' }, deny)).not.toContain('封禁');
    expect(await run('search_messages', { query: '封禁' }, deny)).not.toContain('封禁捣乱');
    const pivot = (await run('search_messages', { query: '封禁' }, ctx({ canQuoteChannel: () => true }))).match(/⟨(\d+)⟩/)![1];
    expect(await run('read_channel_history', { around: pivot }, deny)).toContain('不能在这里转述');
    // 没有判断函数（非 Discord 环境）：只能读当前频道
    expect(await run('read_person_messages', { user: 'bob' })).toContain('公开频道里的闲聊');
    expect(await run('read_person_messages', { user: 'bob' })).not.toContain('封禁');
    // 在那个频道里问：当前频道总可以
    expect(await run('read_channel_history', {}, ctx({ channelId: ADMIN }))).toContain('封禁捣乱');
  });
});

describe('改成敏感（审查修复，第 9 轮）', () => {
  test('revise_memory 把记忆改成敏感：画像和未置顶的反思立即失效', async () => {
    const m = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿丽正在和小周交往', origin: 'extractor' });
    const trait = addMemory({ scope: 'user', subjectId: A, kind: 'trait', content: '恋爱中', origin: 'reflection' });
    getDatabase().run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('user', ?, '阿丽正在和小周交往', 0, 'm', 1)", [A]);
    expect(await run('revise_memory', { id: m.id, sensitive: true })).toContain('已更新');
    expect(getDatabase().query('SELECT COUNT(*) AS c FROM profiles WHERE subject_id = ?').get(A)).toEqual({ c: 0 });
    expect(getMemory(trait.id)).toBeNull();
  });
});

describe('第 11 轮审查修复', () => {
  test('revise_memory 改了共享记忆的内容：说话人记进参与者、本轮消息记进证据', async () => {
    const m = addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'event', content: '周六去爬山', origin: 'extractor', sourceUserId: B, participants: [B] });
    expect(await run('revise_memory', { id: m.id, content: '改到周日去湖边烧烤' }, ctx({ excludeMessageId: '900000000000000001' }))).toContain('已更新');
    const row = getMemory(m.id)!;
    expect(JSON.parse(row.participants!)).toEqual([B, A]);
    expect(JSON.parse(row.evidence!)).toContain('900000000000000001');
  });
});
