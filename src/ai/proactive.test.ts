import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { getDatabase } from '../storage';
import { markBotMessage } from './channels';
import { setOptOut, upsertUser } from './identity';
import { ingestMessage } from './ingest';
import { recordUsage } from './llm-client';
import { addMemory } from './memory/store';
import type { StoredMessage } from './messages';
import { parsePersonaCard, type PersonaCard } from './persona/card';
import { DEFAULT_PERSONA_YAML } from './persona/default-memecat';
import {
  adjustBias,
  botNames,
  channelBias,
  collectTriggers,
  computeScore,
  decayBiases,
  gateReason,
  inQuietHours,
  judge,
  onFollowupMessage,
  onProactiveReaction,
  recordProactiveReaction,
  releaseJudge,
  releaseProactive,
  reserveJudge,
  reserveProactive,
  resetProactiveForTesting,
  setQuiet,
  settleExpired,
  trackProactive,
  validateJudge,
  type ChannelRef,
  type Trigger,
} from './proactive';
import { CHANNEL_ID, GUILD_ID, ingestFixture, installFakeLlm, setupAiTest, userInfo } from '../testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';
const MIN = 60_000;
const HOUR = 60 * MIN;
const ref: ChannelRef = { channelId: CHANNEL_ID, guildId: GUILD_ID, parentId: null };

const res = parsePersonaCard(parseYaml(DEFAULT_PERSONA_YAML), 'memecat');
if (!res.ok) throw new Error(res.error);
const persona: PersonaCard = res.card;

/** UTC+8 某日某时（默认人设 22 点精力 0.8，不在作息安静时段） */
const at = (h: number, m = 0): number => Date.UTC(2026, 9, 24, h - 8, m);

function say(authorId: string, content: string, createdAt: number, extra: Parameters<typeof ingestFixture>[0] = {}): string {
  const f = ingestFixture({ authorId, username: authorId === A ? 'awei' : 'bob', content, createdAt, ...extra });
  ingestMessage(f, { forceKind: true });
  return f.messageId;
}

function botSays(content: string, createdAt: number, proactive = false): string {
  const id = say('900000000000000001', content, createdAt, { kind: 'bot_ai', proactive, username: 'memecat' });
  markBotMessage(CHANNEL_ID, createdAt);
  return id;
}

let fake: ReturnType<typeof installFakeLlm> | null = null;

beforeEach(() => {
  setupAiTest({ proactive: { enabled: true } });
  resetProactiveForTesting();
  upsertUser(userInfo(A, 'awei'), Date.now());
  upsertUser(userInfo(B, 'bob'), Date.now());
});
afterEach(() => {
  fake?.restore();
  fake = null;
});

describe('闸门', () => {
  test('安静时段可跨零点', () => {
    expect(inQuietHours('01:00-08:00', at(3))).toBe(true);
    expect(inQuietHours('01:00-08:00', at(8))).toBe(false);
    expect(inQuietHours('23:00-07:00', at(23, 30))).toBe(true);
    expect(inQuietHours('23:00-07:00', at(6, 59))).toBe(true);
    expect(inQuietHours('23:00-07:00', at(12))).toBe(false);
    expect(inQuietHours('乱写', at(3))).toBe(false);
  });

  test('正常情况放行；最后一条是 bot 自己说的则不插话', () => {
    const now = at(22);
    say(A, '有人在吗', now - MIN);
    expect(gateReason(ref, persona, now, false)).toBeNull();
    botSays('在', now - 30_000);
    // 冷却也会拦，这里把冷却调成 0 只看"最后一条是 bot"
    setupAiTest({ proactive: { enabled: true, cooldownMinutes: 0 } });
    say(A, '有人在吗', now - MIN);
    say('900000000000000001', '在', now - 30_000, { kind: 'bot_ai', username: 'memecat' });
    expect(gateReason(ref, persona, now, false)).toBe('last-is-bot');
  });

  test('没开 / 没人设 / 频道黑白名单', () => {
    const now = at(22);
    say(A, '有人在吗', now - MIN);
    expect(gateReason(ref, null, now, false)).toBe('no-persona');
    setupAiTest({ proactive: { enabled: false } });
    expect(gateReason(ref, persona, now, false)).toBe('disabled');
    setupAiTest({ proactive: { enabled: true, denyChannels: [CHANNEL_ID] } });
    expect(gateReason(ref, persona, now, false)).toBe('channel-denied');
    setupAiTest({ proactive: { enabled: true, channels: ['700000000000000999'] } });
    expect(gateReason(ref, persona, now, false)).toBe('channel-not-allowed');
    setupAiTest({ proactive: { enabled: true, channels: ['700000000000000999'] } });
    expect(gateReason({ ...ref, parentId: '700000000000000999' }, persona, now, false)).not.toBe('channel-not-allowed');
  });

  test('作息：没配 quietHours 时按人设精力曲线（早上 6–8 点犯困不插话）；配了就按配置', () => {
    say(A, '早', at(7) - MIN);
    expect(gateReason(ref, persona, at(7), false)).toBe('quiet-hours');
    setupAiTest({ proactive: { enabled: true, quietHours: '21:00-23:00' } });
    say(A, '晚上好', at(22) - MIN);
    expect(gateReason(ref, persona, at(22), false)).toBe('quiet-hours');
    expect(gateReason(ref, persona, at(7), false)).toBeNull();
  });

  test('冷却：普通 10 分钟；被叫名字只要 60 秒', () => {
    const now = at(22);
    botSays('刚说过话', now - 5 * MIN);
    say(A, 'memecat 你说呢', now - 10_000);
    expect(gateReason(ref, persona, now, false)).toBe('cooldown');
    expect(gateReason(ref, persona, now, true)).toBeNull();
    expect(gateReason(ref, persona, now - 5 * MIN + 30_000, true)).toBe('cooldown');
  });

  test('/shh：频道与全服暂停，到期或 0 立即恢复', () => {
    const now = at(22);
    say(A, '有人在吗', now - MIN);
    setQuiet('channel', ref, now + HOUR);
    expect(gateReason(ref, persona, now, false)).toBe('shh-channel');
    expect(gateReason(ref, persona, now + HOUR + 1, false)).toBeNull();
    setQuiet('channel', ref, 0);
    expect(gateReason(ref, persona, now, false)).toBeNull();
    setQuiet('guild', ref, now + HOUR);
    expect(gateReason(ref, persona, now, false)).toBe('shh-guild');
    expect(gateReason({ ...ref, guildId: '800000000000000099' }, persona, now, false)).not.toBe('shh-guild');
    setQuiet('guild', ref, 0);
    expect(gateReason(ref, persona, now, false)).toBeNull();
  });

  test('每频道每小时、每天、判断调用次数上限', () => {
    setupAiTest({ proactive: { enabled: true, cooldownMinutes: 0, maxPerHourPerChannel: 2, maxPerDay: 3, maxJudgeCallsPerDay: 5 } });
    const now = at(22);
    botSays('插话1', now - 50 * MIN, true);
    botSays('插话2', now - 40 * MIN, true);
    say(A, '嗯', now - MIN);
    expect(gateReason(ref, persona, now, false)).toBe('hour-cap');
    expect(gateReason(ref, persona, now + 15 * MIN, false)).toBeNull();
    // 别的频道今天又插过一次 → 达到每天 3 次
    say('900000000000000001', '插话3', now - 2 * HOUR, {
      kind: 'bot_ai',
      proactive: true,
      username: 'memecat',
      channel: { channelId: '700000000000000002', guildId: GUILD_ID, parentId: null, name: '别处', type: 'text' },
    });
    expect(gateReason(ref, persona, now + 15 * MIN, false)).toBe('day-cap');
    setupAiTest({ proactive: { enabled: true, maxJudgeCallsPerDay: 2 } });
    say(A, '嗯', now - MIN);
    recordUsage('proactive', 'm', { prompt_tokens: 1 }, now);
    recordUsage('proactive', 'm', { prompt_tokens: 1 }, now);
    expect(gateReason(ref, persona, now, false)).toBe('judge-cap');
  });
});

describe('闸门：并发与退出记录', () => {
  test('名额预占：几个频道同时通过检查时，预占的名额计入上限；发完或放弃后释放', () => {
    setupAiTest({ proactive: { enabled: true, cooldownMinutes: 0, maxPerDay: 2, maxPerHourPerChannel: 1 } });
    resetProactiveForTesting();
    const now = at(22);
    const other: ChannelRef = { channelId: '700000000000000002', guildId: GUILD_ID, parentId: null };
    expect(reserveProactive(ref, now)).toBe(true);
    // 同一频道每小时 1 次：已被预占
    expect(reserveProactive(ref, now)).toBe(false);
    expect(reserveProactive(other, now)).toBe(true);
    // 每天 2 次：两个频道各预占了一次
    expect(reserveProactive({ ...other, channelId: '700000000000000003' }, now)).toBe(false);
    say(A, '嗯', now - MIN);
    expect(gateReason(ref, persona, now, false)).toBe('hour-cap');
    releaseProactive(ref);
    releaseProactive(other);
    expect(gateReason(ref, persona, now, false)).toBeNull();
    // 发送前的复查不看次数（名额已经预占了），只看静默、冷却等
    setQuiet('channel', ref, now + HOUR);
    expect(gateReason(ref, persona, now, false, { recheck: true })).toBe('shh-channel');
  });

  test('判断调用也预占名额：几个频道同时评估时不会突破每日判断上限', () => {
    setupAiTest({ proactive: { enabled: true, maxJudgeCallsPerDay: 2 } });
    resetProactiveForTesting();
    const now = at(22);
    expect(reserveJudge(now)).toBe(true);
    expect(reserveJudge(now)).toBe(true);
    expect(reserveJudge(now)).toBe(false);
    say(A, '嗯', now - MIN);
    expect(gateReason(ref, persona, now, false)).toBe('judge-cap');
    releaseJudge();
    expect(reserveJudge(now)).toBe(true);
  });

  test('之后 /optout 的人：退出前留下的消息不再触发插话，也不进判断的上下文', async () => {
    const now = at(22);
    say(A, 'memecat 你说呢', now - MIN);
    expect((await collectTriggers(ref, persona, now)).triggers.map((t) => t.kind)).toContain('alias');
    setOptOut(A, true);
    const scan = await collectTriggers(ref, persona, now);
    expect(scan.triggers).toEqual([]);
    expect(scan.recent.some((m) => m.author_id === A)).toBe(false);
  });
});

describe('信号与打分', () => {
  test('叫名字：人设名字、别名、群里给 bot 起的外号；单字不算', () => {
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'bot_alias', content: '大家叫 bot 喵喵酱', value: '喵喵酱', origin: 'extractor' });
    addMemory({ scope: 'guild', subjectId: GUILD_ID, kind: 'bot_alias', content: '有人叫 bot 猫', value: '猫', origin: 'extractor' });
    const names = botNames(persona, GUILD_ID);
    expect(names).toContain('memecat');
    expect(names).toContain('喵喵酱');
    expect(names).not.toContain('猫');
  });

  test('alias / about_bot：最新一条叫了名字是 alias，前几条在聊 bot 是 about_bot', async () => {
    const now = at(22);
    say(A, '咪咪今天怎么不说话', now - 3 * MIN);
    say(B, '可能睡了', now - 2 * MIN);
    let scan = await collectTriggers(ref, persona, now);
    expect(scan.triggers.map((t) => t.kind)).toEqual(['about_bot']);
    say(A, 'memecat 出来', now - MIN);
    scan = await collectTriggers(ref, persona, now);
    expect(scan.triggers.map((t) => t.kind)).toContain('alias');
    expect(scan.triggers.map((t) => t.kind)).not.toContain('about_bot');
  });

  test('bot 说话之后才算新消息；只有 bot 说过话时没有信号', async () => {
    const now = at(22);
    say(A, 'memecat 在吗', now - 3 * MIN);
    botSays('在', now - 2 * MIN);
    expect((await collectTriggers(ref, persona, now)).triggers).toEqual([]);
  });

  test('问题：2 分钟没人回答才算，否则给出复查时刻；别人回答了就不算', async () => {
    const now = at(22);
    const qAt = now - 30_000;
    say(A, '有人知道 Rust 的生命周期怎么理解吗', qAt);
    let scan = await collectTriggers(ref, persona, now);
    expect(scan.triggers.map((t) => t.kind)).not.toContain('question');
    expect(scan.recheckAt).toBe(qAt + 2 * MIN);
    scan = await collectTriggers(ref, persona, qAt + 2 * MIN);
    expect(scan.triggers.map((t) => t.kind)).toContain('question');
    say(B, '看 the book 第十章', qAt + MIN);
    scan = await collectTriggers(ref, persona, qAt + 3 * MIN);
    expect(scan.triggers.map((t) => t.kind)).not.toContain('question');
    expect(scan.recheckAt).toBeNull();
  });

  test('兴趣：人设感兴趣的话题；情绪：只对关系不错的人', async () => {
    const now = at(22);
    say(A, '今晚吃什么，想吃罐头', now - MIN);
    expect((await collectTriggers(ref, persona, now)).triggers.map((t) => t.kind)).toContain('interest');
    say(B, '面试又挂了，好累', now - 30_000);
    expect((await collectTriggers(ref, persona, now)).triggers.map((t) => t.kind)).not.toContain('emotion');
    getDatabase().run('INSERT INTO relationships (user_id, affinity, updated_at) VALUES (?, 30, ?)', [B, now]);
    expect((await collectTriggers(ref, persona, now)).triggers.map((t) => t.kind)).toContain('emotion');
  });

  test('记忆（无向量）：当事人的某条记忆里同时出现至少两个三字片段', async () => {
    const now = at(22);
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟在准备考研究生，目标是计算机专业', origin: 'extractor' });
    say(A, '随便聊聊天气', now - 2 * MIN);
    expect((await collectTriggers(ref, persona, now)).triggers.map((t) => t.kind)).not.toContain('memory');
    say(A, '考研究生真的好难啊', now - MIN);
    const scan = await collectTriggers(ref, persona, now);
    const mem = scan.triggers.find((t) => t.kind === 'memory');
    expect(mem?.note).toContain('考研究生');
  });

  test('打分：权重和封顶 1.5 × 话痨 × 情绪 × 频道偏置 × 好感', () => {
    setupAiTest({ proactive: { enabled: true }, mood: { enabled: false } });
    const now = at(22);
    const tr = (kind: Trigger['kind'], weight: number): Trigger => ({ kind, weight, messageId: '1', note: '' });
    const recent = [{ author_id: A }] as unknown as StoredMessage[];
    expect(computeScore([], persona, recent, 0, now)).toBe(0);
    const base = computeScore([tr('question', 0.5)], persona, recent, 0, now);
    expect(base).toBeCloseTo(0.5 * (0.5 + 0.35), 5);
    expect(computeScore([tr('alias', 1), tr('about_bot', 0.8), tr('memory', 0.6)], persona, recent, 0, now)).toBeCloseTo(1.5 * 0.85, 5);
    expect(computeScore([tr('question', 0.5)], persona, recent, -0.5, now)).toBeCloseTo(base * 0.5, 5);
    expect(computeScore([tr('question', 0.5)], persona, recent, 5, now)).toBeCloseTo(base * 2, 5);
    getDatabase().run('INSERT INTO relationships (user_id, affinity, updated_at) VALUES (?, -70, ?)', [A, now]);
    expect(computeScore([tr('question', 0.5)], persona, recent, 0, now)).toBeCloseTo(base * 0.5, 5);
    getDatabase().run('UPDATE relationships SET affinity = 60 WHERE user_id = ?', [A]);
    expect(computeScore([tr('question', 0.5)], persona, recent, 0, now)).toBeCloseTo(base * 1.2, 5);
  });

  test('打分：犯困时几乎不插话', () => {
    const tr: Trigger = { kind: 'question', weight: 0.5, messageId: '1', note: '' };
    const sleepy = computeScore([tr], persona, [], 0, at(7));
    const awake = computeScore([tr], persona, [], 0, at(22));
    expect(sleepy).toBeLessThan(awake * 0.5);
  });
});

describe('LLM 判断', () => {
  test('校验：目标必须是成员消息；react 需要表情且允许；乱写当作不插话', () => {
    const userMsg = { message_id: 'u1', msg_kind: 'user' } as never;
    const botMsg = { message_id: 'b1', msg_kind: 'bot_ai' } as never;
    const refs = new Map([
      ['m1', userMsg],
      ['m2', botMsg],
    ]);
    expect(validateJudge('reply', refs, true)).toBeNull();
    expect(validateJudge({ action: 'shout' }, refs, true)).toBeNull();
    expect(validateJudge({ action: 'none', reason: '没必要' }, refs, true)).toEqual({ action: 'none', target: null, emoji: null, reason: '没必要' });
    expect(validateJudge({ action: 'reply', target: 'm1', reason: 'x' }, refs, true)?.target).toBe(userMsg);
    expect(validateJudge({ action: 'reply', target: 'm2' }, refs, true)?.action).toBe('none');
    expect(validateJudge({ action: 'reply', target: 'm9' }, refs, true)?.action).toBe('none');
    expect(validateJudge({ action: 'react', target: 'm1', emoji: ':joy:' }, refs, true)).toMatchObject({ action: 'react', emoji: ':joy:' });
    expect(validateJudge({ action: 'react', target: 'm1', emoji: ':joy:' }, refs, false)?.action).toBe('none');
    expect(validateJudge({ action: 'react', target: 'm1' }, refs, true)?.action).toBe('none');
  });

  test('判断请求带上理由、最近聊天、心情；按编号映射回消息；记入 proactive 用量', async () => {
    const now = at(22);
    say(A, '有人知道 Rust 的生命周期怎么理解吗', now - 3 * MIN);
    const scan = await collectTriggers(ref, persona, now);
    fake = installFakeLlm(() => JSON.stringify({ action: 'reply', target: 'm1', reason: '我知道答案' }));
    const decision = await judge(persona, scan, now);
    expect(decision.action).toBe('reply');
    expect(decision.target?.content_text).toContain('生命周期');
    expect(fake.calls[0].system).toContain('memecat');
    expect(fake.calls[0].system).toContain('你现在的心情');
    expect(fake.calls[0].user).toContain('问题没人回答');
    expect(fake.calls[0].user).toContain('[m1]');
    const usage = getDatabase().query("SELECT SUM(calls) AS c FROM llm_usage WHERE purpose = 'proactive'").get() as { c: number };
    expect(usage.c).toBe(1);
  });

  test('判断输出无法解析时安全地不插话', async () => {
    const now = at(22);
    say(A, '有人知道 Rust 的生命周期怎么理解吗', now - 3 * MIN);
    const scan = await collectTriggers(ref, persona, now);
    fake = installFakeLlm(() => '我觉得可以插话');
    await expect(judge(persona, scan, now)).rejects.toThrow();
  });
});

describe('反馈自适应', () => {
  test('被回复 / 被 @ / 贴表情 → +0.1；被嫌插嘴 → -0.3；10 分钟没人理 → -0.05', () => {
    const now = at(22);
    say(A, '嗯', now - MIN);
    trackProactive('p1', ref, now);
    expect(onFollowupMessage({ channelId: CHANNEL_ID, replyToId: null, text: '哈哈', addressedToBot: false }, persona, now + MIN)).toBe(false);
    expect(onFollowupMessage({ channelId: CHANNEL_ID, replyToId: 'p1', text: '确实', addressedToBot: false }, persona, now + MIN)).toBe(true);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(0.1, 5);
    // 同一条只结算一次
    onProactiveReaction('p1', () => persona);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(0.1, 5);

    trackProactive('p2', ref, now);
    onProactiveReaction('p2', () => persona);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(0.2, 5);

    trackProactive('p3', ref, now);
    expect(onFollowupMessage({ channelId: CHANNEL_ID, replyToId: null, text: '没人问你', addressedToBot: false }, persona, now + MIN)).toBe(true);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(-0.1, 5);

    trackProactive('p4', ref, now);
    expect(settleExpired(() => persona, now + 5 * MIN)).toBe(0);
    expect(settleExpired(() => persona, now + 11 * MIN)).toBe(1);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(-0.15, 5);
    // 超出 10 分钟窗口的消息不再算反馈
    trackProactive('p5', ref, now);
    expect(onFollowupMessage({ channelId: CHANNEL_ID, replyToId: 'p5', text: '嗯', addressedToBot: false }, persona, now + 11 * MIN)).toBe(false);
    const moods = getDatabase().query("SELECT COUNT(*) AS c FROM mood_events WHERE source = 'proactive'").get() as { c: number };
    expect(moods.c).toBe(4);
  });

  test('偏置限制在 [-1, 1]，每天向 0 回归 10%（一天只回归一次）', () => {
    const now = at(22);
    say(A, '嗯', now - MIN);
    for (let i = 0; i < 20; i++) adjustBias(CHANNEL_ID, -0.3);
    expect(channelBias(CHANNEL_ID)).toBe(-1);
    expect(decayBiases(now)).toBe(true);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(-0.9, 5);
    expect(decayBiases(now + HOUR)).toBe(false);
    expect(decayBiases(now + 24 * HOUR)).toBe(true);
    expect(channelBias(CHANNEL_ID)).toBeCloseTo(-0.81, 5);
  });
});

describe('只贴表情的主动参与（审查修复，第 7 轮）', () => {
  test('贴表情计入每小时 / 每天的次数上限', () => {
    setupAiTest({ proactive: { enabled: true, cooldownMinutes: 0, maxPerDay: 3, maxPerHourPerChannel: 2 } });
    resetProactiveForTesting();
    const now = at(22);
    const other: ChannelRef = { channelId: '700000000000000002', guildId: GUILD_ID, parentId: null };
    say(A, '嗯', now - MIN);
    recordProactiveReaction(ref, now - 10 * MIN);
    expect(gateReason(ref, persona, now, false)).toBeNull();
    recordProactiveReaction(ref, now - 5 * MIN);
    expect(gateReason(ref, persona, now, false)).toBe('hour-cap');
    // 一小时以后不再计入本小时，但仍计入今天
    recordProactiveReaction(other, now - 2 * HOUR);
    expect(gateReason(ref, persona, now + 2 * HOUR, false)).toBe('day-cap');
    // 超过 24 小时的记录不再计入
    expect(gateReason(ref, persona, now + 25 * HOUR, false)).not.toBe('day-cap');
  });
});
