import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '@/storage';
import { getChannel } from './channels';
import { ingestLiveMessage } from './discord-runtime';
import { setOptOut } from './identity';
import { channelBias, reserveProactive, resetProactiveForTesting, setQuiet } from './proactive';
import { CHANNEL_ID, GUILD_ID, SELF_ID, installFakeLlm, setupAiTest, type FakeLlmRequest } from '@/testing/fixtures';
import { fakeChannel, fakeMessage, type FakeAuthor, type FakeChannel, type FakeMessage } from '@/testing/discord-fakes';
import { beginDirectReply, endDirectReply, onUnaddressedMessage, resetDiscordProactiveForTesting, settleProactiveForTesting } from './discord-proactive';

const SELF: FakeAuthor = { id: SELF_ID, username: 'memecat', bot: true };
const AWEI: FakeAuthor = { id: '100000000000000001', username: 'awei' };
const BOB: FakeAuthor = { id: '100000000000000002', username: 'bob' };
const MIN = 60_000;

let ch: FakeChannel;
let fake: ReturnType<typeof installFakeLlm> | null = null;

/** 与 discord.ts 的消息路径一致：先入库，再交给主动插话 */
function post(author: FakeAuthor, content: string, opts: { ago?: number; replyTo?: FakeMessage } = {}): FakeMessage {
  const m = fakeMessage(ch, author, content, { createdAt: Date.now() - (opts.ago ?? 0), replyTo: opts.replyTo });
  ingestLiveMessage(m, SELF_ID);
  onUnaddressedMessage(m, SELF_ID);
  return m;
}

const isJudge = (r: FakeLlmRequest): boolean => r.system.includes('正在 Discord 群里潜水');

function llm(judgeOut: Record<string, unknown>, chatOut = '生命周期就是引用能活多久，编译器替你盯着。'): void {
  fake = installFakeLlm((r) => (isJudge(r) ? JSON.stringify(judgeOut) : JSON.stringify({ reply: chatOut, reactions: [] })));
}

beforeEach(() => {
  // 作息与情绪不受测试运行时刻影响；第 2 条消息就立刻评估，不等防抖
  setupAiTest({ proactive: { enabled: true, quietHours: '00:00-00:00', forceEvalEveryMessages: 2 }, mood: { enabled: false } });
  resetProactiveForTesting();
  resetDiscordProactiveForTesting();
  ch = fakeChannel(SELF);
});
afterEach(() => {
  resetDiscordProactiveForTesting();
  fake?.restore();
  fake = null;
});

describe('主动插话（Discord 接入）', () => {
  test('没人回答的问题：判断 → 生成 → 直接发到频道、不提醒任何人 → 记为主动插话', async () => {
    llm({ action: 'reply', target: 'm1', reason: '我知道答案' });
    post(AWEI, '有人知道 Rust 的生命周期怎么理解吗', { ago: 3 * MIN });
    post(AWEI, '急', { ago: 2.5 * MIN });
    await settleProactiveForTesting();

    expect(fake!.calls.filter(isJudge)).toHaveLength(1);
    const chat = fake!.calls.find((r) => !isJudge(r))!;
    expect(chat.system).toContain('[主动插话]');
    expect(chat.system).toContain('我知道答案');
    expect(chat.user).toContain('不是对你说的');
    expect(chat.user).toContain('生命周期');

    expect(ch.sent).toHaveLength(1);
    const { message, options, replyTo } = ch.sent[0];
    expect(replyTo).toBeNull();
    expect(options.allowedMentions).toEqual({ repliedUser: false, parse: [], users: [] });
    const row = getDatabase().query('SELECT msg_kind, proactive, content_text FROM messages WHERE message_id = ?').get(message.id) as {
      msg_kind: string;
      proactive: number;
      content_text: string;
    };
    expect(row).toMatchObject({ msg_kind: 'bot_ai', proactive: 1 });
    expect(getChannel(CHANNEL_ID)?.last_bot_message_at).toBeGreaterThan(0);
    expect(ch.typing).toBeGreaterThan(0);

    // 有人回复了这句插话 → 频道偏置 +0.1
    post(AWEI, '原来如此', { replyTo: message });
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(0.1, 5);
  });

  test('叫了名字：以回复的形式接话；插话里的 @ 不会提醒人', async () => {
    llm({ action: 'reply', target: 'm2', reason: '被叫到了' }, '叫我干嘛 <@100000000000000002>');
    post(BOB, '今天好热', { ago: 40_000 });
    const called = post(AWEI, 'memecat 你觉得呢', { ago: 30_000 });
    await settleProactiveForTesting();
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0].replyTo).toBe(called.id);
    expect(ch.sent[0].options.content).toBe('叫我干嘛 @bob');
    expect(ch.sent[0].options.allowedMentions).toEqual({ repliedUser: false, parse: [], users: [] });
  });

  test('判断为 react：只贴表情不说话；判断为 none 或输出乱码：什么都不做', async () => {
    llm({ action: 'react', target: 'm2', emoji: ':thumbsup:', reason: '表示在场' });
    post(BOB, '今天好热', { ago: 40_000 });
    const called = post(AWEI, 'memecat 在不在', { ago: 30_000 });
    await settleProactiveForTesting();
    expect(ch.sent).toHaveLength(0);
    expect(called.reactedWith).toEqual(['👍']);

    fake?.restore();
    fake = installFakeLlm((r) => (isJudge(r) ? '我觉得应该说点什么' : '不该被调用'));
    resetDiscordProactiveForTesting();
    setupAiTest({ proactive: { enabled: true, quietHours: '00:00-00:00', forceEvalEveryMessages: 2, aliasCooldownSeconds: 0 }, mood: { enabled: false } });
    ch = fakeChannel(SELF);
    post(BOB, '今天好热', { ago: 40_000 });
    post(AWEI, 'memecat 在不在', { ago: 30_000 });
    await settleProactiveForTesting();
    expect(ch.sent).toHaveLength(0);
    expect(fake.calls.every(isJudge)).toBe(true);
  });

  test('没有信号或被闸门拦下时不调用 LLM', async () => {
    llm({ action: 'reply', target: 'm1', reason: 'x' });
    post(AWEI, '吃了', { ago: 40_000 });
    post(BOB, '我也吃了', { ago: 30_000 });
    await settleProactiveForTesting();
    expect(fake!.calls).toHaveLength(0);

    setupAiTest({ proactive: { enabled: true, quietHours: '00:00-00:00', forceEvalEveryMessages: 2, denyChannels: [CHANNEL_ID] }, mood: { enabled: false } });
    post(AWEI, 'memecat 在吗', { ago: 40_000 });
    post(BOB, 'memecat 出来', { ago: 30_000 });
    await settleProactiveForTesting();
    expect(fake!.calls).toHaveLength(0);
  });

  test('防抖：频道安静 debounceSeconds 之后才评估', async () => {
    setupAiTest({ proactive: { enabled: true, quietHours: '00:00-00:00', debounceSeconds: 1 }, mood: { enabled: false } });
    llm({ action: 'none', reason: '不用' });
    post(AWEI, 'memecat 在吗', { ago: 10_000 });
    await settleProactiveForTesting();
    expect(fake!.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1200));
    await settleProactiveForTesting();
    expect(fake!.calls.filter(isJudge)).toHaveLength(1);
  });

  test('生成期间管理员 /shh：生成完也不发；名额随之释放', async () => {
    fake = installFakeLlm((r) => {
      if (isJudge(r)) return JSON.stringify({ action: 'reply', target: 'm2', reason: '被叫到了' });
      // 模拟生成的这几秒里有人执行了 /shh
      setQuiet('channel', { channelId: CHANNEL_ID, guildId: GUILD_ID, parentId: null }, Date.now() + 3600_000);
      return JSON.stringify({ reply: '我来了', reactions: [] });
    });
    post(BOB, '今天好热', { ago: 40_000 });
    post(AWEI, 'memecat 你说呢', { ago: 30_000 });
    await settleProactiveForTesting();
    expect(fake.calls.some((r) => !isJudge(r))).toBe(true);
    expect(ch.sent).toHaveLength(0);
    expect(reserveProactive({ channelId: CHANNEL_ID, guildId: GUILD_ID, parentId: null }, Date.now())).toBe(true);
  });

  test('退出记录（/optout）的人不会触发插话，退出前留下的消息也不会被当成插话对象', async () => {
    llm({ action: 'reply', target: 'm1', reason: 'x' });
    post(AWEI, 'memecat 你说呢', { ago: 40_000 });
    setOptOut(AWEI.id, true);
    post(AWEI, 'memecat 在吗', { ago: 30_000 });
    post(AWEI, 'memecat 出来', { ago: 20_000 });
    await settleProactiveForTesting();
    expect(fake!.calls).toHaveLength(0);
    expect(ch.sent).toHaveLength(0);
  });
});

describe('和直接回复的配合（审查修复）', () => {
  test('有人直接 @ bot、普通回复还在生成时：排着的插话被取消，不会对同一条消息再答一遍', async () => {
    setupAiTest({ proactive: { enabled: true, quietHours: '00:00-00:00', debounceSeconds: 1 }, mood: { enabled: false } });
    llm({ action: 'reply', target: 'm1', reason: '被叫到了' });
    post(AWEI, 'memecat 你说呢', { ago: 10_000 });
    beginDirectReply(CHANNEL_ID);
    await new Promise((r) => setTimeout(r, 1200));
    await settleProactiveForTesting();
    endDirectReply(CHANNEL_ID);
    expect(fake!.calls).toHaveLength(0);
  });
});
