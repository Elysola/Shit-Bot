import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { getDatabase } from '@/storage';
import { registerAffinityAndMood } from './appraise';
import { AI_MIGRATIONS } from '@/plugins/ai-chat/db/schema';
import { forgetUser as forgetUserForTest } from './forget';
import { aiCommandDefinitions, handleAiCommand } from './commands';
import { decidePrivilegedIntents } from '@/bots/discord-intents';
import { registerExtraction, scheduleDueWindows } from '@/plugins/ai-chat/memory/extract';
import { registerProfiles } from '@/plugins/ai-chat/memory/profile';
import { listMemories } from '@/plugins/ai-chat/memory/store';
import { channelBias, resetProactiveForTesting } from './proactive';
import { getRelationship } from './affinity';
import { drainJobs } from './worker';
import { GUILD_ID, SELF_ID, installFakeLlm, setupAiTest, type FakeLlmRequest } from '@/testing/fixtures';
import { fakeChannel, fakeClient, fakeInteraction, fakeMessage, type FakeAuthor, type FakeChannel, type FakeClient, type FakeMessage } from '@/testing/discord-fakes';
import { useDiscordClientForTesting } from '@/bots/discord';
import { initDiscordAiChat } from './discord-chat';
import { resetDiscordProactiveForTesting, settleProactiveForTesting } from './discord-proactive';

/**
 * 离线验收：把 .claude/TASK.md 里的人工验收清单逐项跑一遍。
 * 走的是真实的 discord.ts 消息处理链与斜杠命令分发，只把 Discord 换成假客户端、把模型换成按场景编排的假模型；
 * 能验证的是"每一步的数据有没有流到该去的地方"，模型本身的发挥（语气像不像、答得对不对）仍需要在真实服务器上看。
 */

const SELF: FakeAuthor = { id: SELF_ID, username: 'memecat', bot: true };
const AWEI: FakeAuthor = { id: '100000000000000001', username: 'awei', nickname: '阿伟' };
const HONG: FakeAuthor = { id: '100000000000000002', username: 'xiaohong', nickname: '小红' };
const CAROL: FakeAuthor = { id: '100000000000000003', username: 'carol', nickname: null };
const ALT: FakeAuthor = { id: '100000000000000009', username: 'alt_account', nickname: '小号' };
const MIN = 60_000;

/** UTC+8 2026-10-24 22:00：人设作息里精神最好的时候，结果不受测试运行时刻影响 */
const T0 = Date.UTC(2026, 9, 24, 14, 0);

registerExtraction();
registerProfiles();
registerAffinityAndMood();

type Kind = 'chat' | 'extract' | 'appraise' | 'judge' | 'profile';
type Brain = Partial<Record<Kind, (r: FakeLlmRequest) => unknown>>;

const DEFAULTS: Record<Kind, (r: FakeLlmRequest) => unknown> = {
  chat: () => ({ reply: '嗯哼', reactions: [] }),
  extract: () => ({ episode: null, ops: [], bot_sentiment: [], atmosphere: null }),
  appraise: () => ({ delta: 0, category: '闲聊', reason: '普通聊天', mood: { dv: 0, da: 0 } }),
  judge: () => ({ action: 'none', reason: '不用' }),
  profile: () => ({ summary: '一个普通的群友。', traits: [], pin: [], unpin: [] }),
};

function kindOf(r: FakeLlmRequest): Kind {
  if (r.system.includes('正在 Discord 群里潜水')) return 'judge';
  if (r.system.includes('记忆整理员')) return 'extract';
  if (r.system.includes('的内心。刚才你在 Discord 上')) return 'appraise';
  if (r.system.includes('整理对群友') || r.system.includes('整理对服务器')) return 'profile';
  return 'chat';
}

let brain: Brain = {};
let calls: Array<{ kind: Kind; req: FakeLlmRequest }> = [];
let fake: ReturnType<typeof installFakeLlm> | null = null;
let client: FakeClient;
let ch: FakeChannel;

const callsOf = (k: Kind): FakeLlmRequest[] => calls.filter((c) => c.kind === k).map((c) => c.req);
const lastUser = (r: FakeLlmRequest): string => {
  const msgs = r.body.messages as Array<{ role: string; content: unknown }>;
  const u = [...msgs].reverse().find((m) => m.role === 'user');
  return typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content ?? '');
};
/** 判断请求里某条消息的编号（[m3] 之类） */
const refFor = (r: FakeLlmRequest, text: string): string => r.user.split('\n').find((l) => l.includes(text))?.match(/^\[(m\d+)\]/)?.[1] ?? 'm1';

function advance(ms: number): number {
  const now = Date.now() + ms;
  setSystemTime(new Date(now));
  return now;
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`等待超时：${what}`);
    await Bun.sleep(10);
  }
}

/** 有人在频道里发一条消息（经过 bot 的 messageCreate 处理链） */
function say(author: FakeAuthor, content: string, opts: { mentions?: FakeAuthor[]; replyTo?: FakeMessage; ago?: number } = {}): FakeMessage {
  const m = fakeMessage(ch, author, content, { createdAt: Date.now() - (opts.ago ?? 0), mentions: opts.mentions, replyTo: opts.replyTo });
  client.emitMessage(m);
  return m;
}

/** @ bot 说一句，等它回复完 */
async function ask(author: FakeAuthor, content: string, mentions: FakeAuthor[] = []): Promise<{ msg: FakeMessage; reply: FakeChannel['sent'][number] }> {
  const before = ch.sent.length;
  const msg = say(author, `<@${SELF_ID}> ${content}`, { mentions: [SELF, ...mentions] });
  await waitFor(() => ch.sent.length > before, `bot 回复「${content}」`);
  return { msg, reply: ch.sent[ch.sent.length - 1] };
}

async function command(name: string, user: FakeAuthor, options: Record<string, string | number> = {}, click: string | null = null): Promise<string[]> {
  const it = fakeInteraction(name, user, ch, options, { click });
  expect(await handleAiCommand(it)).toBe(true);
  return it.replies;
}

const count = (sql: string, ...params: string[]): number => (getDatabase().query(sql).get(...params) as { c: number }).c;

function rowsContaining(needle: string): string[] {
  const db = getDatabase();
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'memories_fts%' AND name NOT LIKE 'vec_bin_%'")
    .all() as Array<{ name: string }>;
  const hits: string[] = [];
  for (const { name } of tables) {
    for (const row of db.query(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) {
      if (Object.values(row).some((v) => !(v instanceof Uint8Array) && String(v ?? '').includes(needle))) hits.push(name);
    }
  }
  return hits;
}

function setup(extraAi: Record<string, unknown> = {}): void {
  setupAiTest(
    {
      allowedGuildIds: [GUILD_ID],
      memory: { enabled: true, extractor: { dailyTokenBudget: 0 } },
      proactive: { enabled: true, debounceSeconds: 1 },
      ...extraAi,
    },
    { discord: { enabled: true, token: 'x' } }
  );
  resetProactiveForTesting();
  resetDiscordProactiveForTesting();
  client = fakeClient(SELF);
  useDiscordClientForTesting(client);
  expect(initDiscordAiChat()).toBe(true);
  ch = fakeChannel(SELF);
  // 真实 Discord 里 bot 自己发出的消息也会作为 messageCreate 事件回来一次（这里模拟它先于发送方的入库到达）
  ch.onSent = (m) => client.emitMessage(m);
}

beforeEach(() => {
  setSystemTime(new Date(T0));
  brain = {};
  calls = [];
  fake = installFakeLlm((r) => {
    const kind = kindOf(r);
    calls.push({ kind, req: r });
    const out = (brain[kind] ?? DEFAULTS[kind])(r);
    return typeof out === 'string' ? out : JSON.stringify(out);
  });
  setup();
});

afterEach(() => {
  resetDiscordProactiveForTesting();
  useDiscordClientForTesting(null);
  fake?.restore();
  fake = null;
  setSystemTime();
});

describe('验收：启动', () => {
  test('数据结构迁移到最新版本；特权 intent 按开发者后台开关自适配（你的应用两个都没开 → 降级运行）', async () => {
    const versions = (getDatabase().query('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual(AI_MIGRATIONS.map((m) => m.version).sort((a, b) => a - b));
    const appFlags = (flags: number): typeof fetch => (async () => new Response(JSON.stringify({ flags }), { status: 200 })) as unknown as typeof fetch;
    expect(await decidePrivilegedIntents('t', { members: 'auto', presences: 'auto' }, appFlags(1 << 19))).toMatchObject({ members: false, presences: false });
    expect(await decidePrivilegedIntents('t', { members: 'auto', presences: 'auto' }, appFlags((1 << 12) | (1 << 14)))).toMatchObject({ members: true, presences: true });
  });

  test('斜杠命令齐全，且每一个都符合 Discord 的注册规则（任何一个不合规会导致整批注册失败）', () => {
    const defs = aiCommandDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(['affinity', 'callme', 'forget', 'forget-me', 'memory', 'optin', 'optout', 'pronouns', 'shh']);
    const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;
    for (const d of defs) {
      expect(NAME.test(d.name) && d.name === d.name.toLowerCase()).toBe(true);
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.description.length).toBeLessThanOrEqual(100);
      for (const o of d.options ?? []) {
        expect(NAME.test(o.name) && o.name === o.name.toLowerCase()).toBe(true);
        expect(o.description.length).toBeLessThanOrEqual(100);
        for (const c of o.choices ?? []) expect(c.name.length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('验收：人格与 @', () => {
  test('@ bot 打招呼：以人设卡为第一条系统提示，以回复的形式说话，只提醒说话人', async () => {
    brain.chat = () => ({ reply: '在。干嘛', reactions: [] });
    const { msg, reply } = await ask(AWEI, '你好');
    const chat = callsOf('chat')[0];
    expect((chat.body.messages as Array<{ content: string }>)[0].content.startsWith('# 你的身份\n你是「memecat」。')).toBe(true);
    expect(lastUser(chat)).toBe('[阿伟]: 你好');
    expect(reply.replyTo).toBe(msg.id);
    expect(reply.options.content).toBe('在。干嘛');
    expect(reply.options.allowedMentions).toMatchObject({ parse: [], repliedUser: false });
    // bot 的回复入库为 AI 回复（Discord 回传的同一条消息先被记成"其它 bot 消息"，随后升级）
    expect(getDatabase().query('SELECT msg_kind FROM messages WHERE message_id = ?').get(reply.message.id)).toEqual({ msg_kind: 'bot_ai' });
  });

  test('@ 另一个人问"她是谁"：模型拿到具体的人；回复里只提醒本轮出现过的人', async () => {
    say(CAROL, '大家好', { ago: MIN });
    brain.chat = () => ({ reply: `她是 <@${HONG.id}>，旁边那位是 <@${CAROL.id}>`, reactions: [] });
    const { reply } = await ask(AWEI, `<@${HONG.id}> 她是谁`, [HONG]);
    const chat = callsOf('chat')[0];
    expect(lastUser(chat)).toContain('@小红');
    expect(chat.system).toContain('小红');
    expect(reply.options.content).toBe(`她是 <@${HONG.id}>，旁边那位是 @carol`);
    expect(reply.options.allowedMentions).toMatchObject({ users: [HONG.id] });
  });

  test('@everyone 不会触发 bot 回复（但消息照常入库）', async () => {
    say(HONG, '@everyone 今晚开会');
    await Bun.sleep(200);
    expect(callsOf('chat')).toHaveLength(0);
    expect(ch.sent).toHaveLength(0);
    expect(count('SELECT COUNT(*) AS c FROM messages WHERE author_id = ?', HONG.id)).toBe(1);
  });
});

describe('验收：记忆', () => {
  test('不 @ bot 聊个人信息 → 频道安静后提炼成记忆 → /memory 能看到 → 问 bot 它记得 → /forget 能删', async () => {
    say(AWEI, '我下周三要去面试字节跳动，有点紧张');
    say(HONG, '加油！');
    brain.extract = (r) => ({
      episode: { summary: '阿伟说下周三去字节面试，小红给他打气', importance: 3 },
      ops: [{ op: 'add', scope: 'user', subject: AWEI.id, kind: 'plan', content: '阿伟下周三要去字节跳动面试', importance: 8, evidence: [refFor(r, '面试')], event_at: '2026-10-28' }],
      bot_sentiment: [],
      atmosphere: null,
    });
    // 只有 2 条新消息：不满 8 条，"安静 3 分钟"的条件不成立，要等最早一条满 30 分钟
    expect(scheduleDueWindows(advance(4 * MIN))).toBe(0);
    const later = advance(27 * MIN);
    expect(scheduleDueWindows(later)).toBe(1);
    await drainJobs(later);
    expect(callsOf('extract')).toHaveLength(1);
    // 提炼看到的是全部成员的聊天，不只是和 bot 的对话
    expect(callsOf('extract')[0].user).toContain('加油');
    const [mem] = listMemories({ scope: 'user', subjectId: AWEI.id, includeSensitive: true, limit: 10 });
    expect(mem.content).toBe('阿伟下周三要去字节跳动面试');

    expect((await command('memory', AWEI)).join('\n')).toContain('阿伟下周三要去字节跳动面试');

    brain.chat = (r) => ({ reply: r.system.includes('字节跳动面试') ? '下周三你要去字节面试啊，别忘了' : '不知道', reactions: [] });
    const { reply } = await ask(AWEI, '我下周有什么事');
    expect(reply.options.content).toBe('下周三你要去字节面试啊，别忘了');

    const forgot = await command('forget', AWEI, { id: mem.id });
    expect(forgot.join('\n')).toContain('删');
    expect(listMemories({ scope: 'user', subjectId: AWEI.id, includeSensitive: true, limit: 10 })).toHaveLength(0);
    expect((await command('memory', AWEI)).join('\n')).not.toContain('字节跳动');
  });

  test('/callme 之后 bot 用新称呼', async () => {
    await command('callme', AWEI, { 称呼: '伟哥' });
    brain.chat = (r) => ({ reply: r.system.includes('伟哥') ? '伟哥好' : '阿伟好', reactions: [] });
    const { reply } = await ask(AWEI, '叫我一声');
    expect(reply.options.content).toBe('伟哥好');
  });
});

describe('验收：好感与情绪', () => {
  test('友好聊天 → /affinity 显示档位与印象、不显示数值；骂它 → 态度变冷但底线要求内容照样答对', async () => {
    // 评估模型每次给的理由类别不同（同一类理由反复出现会减半，见下一个测试）
    let n = 0;
    const friendly = ['分享生活', '道谢', '聊游戏'];
    brain.appraise = () => ({ delta: 3, category: friendly[n++ % 3], reason: '认真聊天', impression: '挺有礼貌的人', mood: { dv: 0.1, da: 0, cause: '聊得开心' } });
    for (const t of ['今天天气不错', '谢谢你上次帮我', '你喜欢什么游戏']) {
      await ask(AWEI, t);
      await drainJobs(Date.now());
      advance(MIN);
    }
    expect(getRelationship(AWEI.id)?.affinity).toBe(9);
    const aff = (await command('affinity', AWEI)).join('\n');
    expect(aff).toContain('普通');
    expect(aff).toContain('挺有礼貌的人');
    // 只有互动次数是数字，好感数值本身不出现
    expect(aff.replace(/聊过 \d+ 次/, '')).not.toMatch(/\d/);

    const hostile = ['辱骂', '嘲讽', '人身攻击', '挑衅'];
    n = 0;
    brain.appraise = () => ({ delta: -8, category: hostile[n++ % 4], reason: '骂人', impression: '嘴很臭', mood: { dv: -0.3, da: 0.2, cause: '被骂了' } });
    for (let i = 0; i < 4; i++) {
      await ask(AWEI, '你个废物');
      await drainJobs(Date.now());
      advance(MIN);
    }
    // 单日扣分上限 30：9 - 30 = -21 → 冷淡
    expect(getRelationship(AWEI.id)?.affinity).toBe(-21);
    await ask(AWEI, 'Python 的 list 和 tuple 有什么区别');
    const sys = callsOf('chat').at(-1)!.system;
    expect(sys).toContain('客气但疏远');
    expect(sys).toContain('态度可以冷，内容必须对');
    expect(sys).toMatch(/心情|情绪/);
    expect((await command('affinity', AWEI)).join('\n')).toContain('冷淡');
  });

  test('好感由评估模型自己判断：同类理由不再机械减半，模型能看到今天的变化记录；只剩每日上限兜底', async () => {
    brain.appraise = () => ({ delta: -8, category: '辱骂', reason: '骂人', mood: { dv: 0, da: 0 } });
    for (let i = 0; i < 4; i++) {
      await ask(AWEI, '你个废物');
      await drainJobs(Date.now());
      advance(MIN);
    }
    // -8 × 3 = -24，第四次被每日 -30 的上限截成 -6
    expect(getRelationship(AWEI.id)?.affinity).toBe(-30);
    expect((await command('affinity', AWEI)).join('\n')).toContain('冷淡');
    const lastAppraisal = callsOf('appraise').at(-1)!;
    expect(lastAppraisal.user).toContain('今天 TA 让你的好感变化过 3 次（共 +0 / -24）');
    expect(lastAppraisal.user).toContain('-8（辱骂）骂人');
  });
});

describe('验收：主动插话', () => {
  test('不 @ 只叫名字：频道安静后以回复的形式接话，不提醒任何人', async () => {
    brain.judge = (r) => ({ action: 'reply', target: refFor(r, 'memecat 你说呢'), reason: '被叫到了' });
    brain.chat = () => ({ reply: '我说啥，你们自己定', reactions: [] });
    const m = say(AWEI, 'memecat 你说呢');
    await Bun.sleep(1300);
    await settleProactiveForTesting();
    await waitFor(() => ch.sent.length === 1, '主动插话');
    expect(ch.sent[0].replyTo).toBe(m.id);
    expect(ch.sent[0].options.allowedMentions).toMatchObject({ users: [] });
    expect(getDatabase().query('SELECT msg_kind, proactive FROM messages WHERE message_id = ?').get(ch.sent[0].message.id)).toEqual({ msg_kind: 'bot_ai', proactive: 1 });
  });

  test('有问题没人答会来答；被说"闭嘴"之后频道偏置 -0.3', async () => {
    brain.judge = (r) => ({ action: 'reply', target: refFor(r, '生命周期'), reason: '我知道答案' });
    brain.chat = () => ({ reply: '生命周期就是引用能活多久', reactions: [] });
    say(AWEI, '有人知道 Rust 的生命周期怎么理解吗', { ago: 3 * MIN });
    await Bun.sleep(1300);
    await settleProactiveForTesting();
    await waitFor(() => ch.sent.length === 1, '回答问题');
    expect(ch.sent[0].replyTo).toBeNull();
    expect(callsOf('judge')).toHaveLength(1);

    say(HONG, '闭嘴，没人问你');
    // 消息先交给其它插件（如 jm-daily 的文本命令）处理，反馈在那之后记录
    await waitFor(() => channelBias(ch.id) !== 0, '记录反馈');
    expect(channelBias(ch.id)).toBeCloseTo(-0.3, 5);
  });

  test('/shh 立即生效（被 @ 照常回复），/shh 0 恢复', async () => {
    brain.judge = (r) => ({ action: 'reply', target: refFor(r, 'memecat 在吗'), reason: '被叫到了' });
    const shh = await command('shh', HONG, { 分钟: 5 });
    expect(shh.join('\n')).toContain('不主动插话');
    say(AWEI, 'memecat 在吗');
    await Bun.sleep(1300);
    await settleProactiveForTesting();
    expect(callsOf('judge')).toHaveLength(0);
    await ask(AWEI, '那 @ 你呢');

    await command('shh', HONG, { 分钟: 0 });
    advance(2 * MIN);
    say(AWEI, 'memecat 在吗');
    await Bun.sleep(1300);
    await settleProactiveForTesting();
    expect(callsOf('judge')).toHaveLength(1);
  });

  test('一天的插话次数不超过 maxPerDay', async () => {
    setup({ proactive: { enabled: true, debounceSeconds: 1, maxPerDay: 2 } });
    brain.judge = (r) => ({ action: 'reply', target: refFor(r, 'memecat'), reason: '被叫到了' });
    for (let i = 0; i < 4; i++) {
      say(AWEI, `memecat 第${i}次`);
      await Bun.sleep(1300);
      await settleProactiveForTesting();
      await Bun.sleep(50);
      advance(25 * MIN);
    }
    expect(count('SELECT COUNT(*) AS c FROM messages WHERE proactive = 1')).toBe(2);
    expect(callsOf('judge')).toHaveLength(2);
  }, 20_000);
});

describe('验收：隐私', () => {
  test('/optout 后说的话不入库、被 @ 仍然回复；/optin 恢复', async () => {
    await command('optout', AWEI);
    say(AWEI, '这句不该被记下');
    await ask(AWEI, '你还理我吗');
    expect(count("SELECT COUNT(*) AS c FROM messages WHERE author_id = ? AND msg_kind = 'user'", AWEI.id)).toBe(0);
    await command('optin', AWEI);
    say(AWEI, '这句可以记');
    await Bun.sleep(50);
    expect(count("SELECT COUNT(*) AS c FROM messages WHERE author_id = ? AND msg_kind = 'user'", AWEI.id)).toBe(1);
  });

  test('小号 /forget-me：取消什么都不删；全部删除后库里搜不到这个 ID；"以后不再记录"只留空标记', async () => {
    say(ALT, '我是小号，我住在杭州');
    say(HONG, `<@${ALT.id}> 你好`, { mentions: [ALT] });
    await ask(ALT, '记住我喜欢吃辣');
    await drainJobs(Date.now());
    expect(rowsContaining(ALT.id).length).toBeGreaterThan(3);

    const cancelled = await command('forget-me', ALT, {}, 'forget-me:cancel');
    expect(cancelled.at(-1)).toContain('已取消');
    expect(rowsContaining(ALT.id).length).toBeGreaterThan(3);

    const done = await command('forget-me', ALT, {}, 'forget-me:all');
    expect(done.at(-1)).toContain('已删除');
    expect(rowsContaining(ALT.id)).toEqual([]);

    say(ALT, '我又回来了');
    await Bun.sleep(50);
    await command('forget-me', ALT, {}, 'forget-me:optout');
    expect(rowsContaining(ALT.id)).toEqual(['users']);
    say(ALT, '这句不会被记录');
    await Bun.sleep(50);
    expect(rowsContaining(ALT.id)).toEqual(['users']);
  });
});

describe('验收：删除与回复的竞态（审查修复）', () => {
  test('从没在群里出现过的老用户执行 /forget-me：先认领旧身份，旧记忆一起删掉', async () => {
    const db = getDatabase();
    db.run(
      "INSERT INTO memories (scope, subject_id, kind, content, importance, confidence, origin, created_at, updated_at) VALUES ('user', 'legacy:alt_account', 'fact', '小号的旧记忆', 5, 0.8, 'legacy', 1, 1)"
    );
    await command('forget-me', ALT, {}, 'forget-me:all');
    expect(rowsContaining('legacy:alt_account')).toEqual([]);
    expect(rowsContaining('小号的旧记忆')).toEqual([]);
  });

  test('有人回复 TA /forget-me 时连带删除的旧 bot 消息：那条消息的原文不会再带进上下文', async () => {
    brain.chat = () => ({ reply: '东京出差记得带伞喵', reactions: [] });
    const { reply: old } = await ask(HONG, '我下个月去东京出差');
    forgetUserForTest(HONG.id);
    brain.chat = () => ({ reply: '那条我已经不记得了', reactions: [] });
    const before = callsOf('chat').length;
    const sentBefore = ch.sent.length;
    say(AWEI, `<@${SELF_ID}> 这条说的是什么？`, { mentions: [SELF], replyTo: old.message });
    await waitFor(() => ch.sent.length > sentBefore, 'bot 回复');
    expect(JSON.stringify(callsOf('chat')[before].body)).not.toContain('东京');
  });

  test('有人回复一条 @ 过已删除的人的旧消息：引用里对 TA 的 @ 匿名化', async () => {
    const old = say(AWEI, `我和 <@${HONG.id}> 下周去东京`, { mentions: [HONG], ago: MIN });
    await Bun.sleep(20);
    forgetUserForTest(HONG.id);
    brain.chat = () => ({ reply: '好像是要去旅游', reactions: [] });
    const before = callsOf('chat').length;
    const sentBefore = ch.sent.length;
    say(CAROL, `<@${SELF_ID}> 他们去干嘛`, { mentions: [SELF], replyTo: old });
    await waitFor(() => ch.sent.length > sentBefore, 'bot 回复');
    const body = JSON.stringify(callsOf('chat')[before].body);
    expect(body).not.toContain(HONG.id);
    expect(body).not.toContain('小红');
  });

  test('生成回复期间回复里涉及的人执行了 /forget-me：用删除后的数据重新生成，不发旧结果', async () => {
    say(HONG, '我下个月要去日本旅游', { ago: MIN });
    let n = 0;
    brain.chat = () => {
      n++;
      if (n === 1) forgetUserForTest(HONG.id);
      return { reply: n === 1 ? '小红下个月去日本' : '不太清楚她的近况', reactions: [] };
    };
    const { reply } = await ask(AWEI, `<@${HONG.id}> 最近在干嘛`, [HONG]);
    expect(n).toBe(2);
    expect(reply.options.content).toBe('不太清楚她的近况');
  });
});
