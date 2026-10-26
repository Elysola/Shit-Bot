import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getConfig } from '../../config';
import { getDatabase } from '../../storage';
import { setOptOut, upsertMember, upsertUser } from '../identity';
import { ingestMessage } from '../ingest';
import { MAX_ATTEMPTS, drainJobs } from '../worker';
import { buildCandidates, hasSubstance, loadWindow, registerExtraction, runExtractWindow, scheduleDueWindows } from './extract';
import { onAtmosphere, onBotSentiment, type Atmosphere, type BotSentiment } from './signals';
import { activeSlot, addMemory, getMemory, listMemories } from './store';
import { CHANNEL_ID, GUILD_ID, SELF_ID, ingestFixture, installFakeLlm, memberInfo, personRef, setupAiTest, userInfo } from '../../testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';
const D = '100000000000000004';
const USERS: Array<[string, string, string]> = [
  [A, 'awei', '阿伟'],
  [B, 'xiaohong', '小红'],
  [C, 'laowang', '老王'],
  [D, 'dada', '大大'],
];

registerExtraction();
let fake: ReturnType<typeof installFakeLlm> | null = null;

beforeEach(() => {
  setupAiTest({ memory: { enabled: true, extractor: { windowMessages: 40, idleSeconds: 60, maxWaitMinutes: 30, dailyTokenBudget: 0 } } });
  const now = Date.now();
  for (const [id, username, nick] of USERS) {
    upsertUser(userInfo(id, username), now);
    upsertMember(memberInfo(id, { nickname: nick }), userInfo(id, username), now);
  }
  getDatabase().run("INSERT INTO kv_meta (key, value) VALUES ('bot.user_id', ?)", [SELF_ID]);
});

afterEach(() => {
  fake?.restore();
  fake = null;
  onBotSentiment(null);
  onAtmosphere(null);
});

/** 一个"如实整理"的假抽取器：把每条有内容的成员发言整理成一条关于作者本人的记忆 */
function echoExtractor(): string {
  const req = fake!.calls[fake!.calls.length - 1];
  const ops: unknown[] = [];
  for (const line of req.user.split('\n')) {
    const m = line.match(/^\[(m\d+)\] \S+ \S+ (.+?)\((\d+)\): (.*)$/);
    if (!m) continue;
    const [, ref, name, id, text] = m;
    if ([...text.replace(/[\s\p{P}]/gu, '')].length < 4) continue;
    ops.push({ op: 'add', scope: 'user', subject: id, kind: 'fact', content: `${name}说：${text}`, importance: 4, evidence: [ref] });
  }
  return JSON.stringify({ episode: { summary: '大家在闲聊', importance: 2 }, ops, bot_sentiment: [], atmosphere: { tone: '平常', valence: 0.1, arousal: 0.4 } });
}

describe('窗口抽取（验收：完全不涉及 bot 的群聊）', () => {
  test('200 条群聊跑完后，每个说过有内容的话的人都有记忆，所有消息都标记为已处理', async () => {
    fake = installFakeLlm(() => echoExtractor());
    const t0 = Date.now() - 6 * 3600_000;
    const topics = ['今天去健身房练腿', '周末打算去西湖边骑车', '新买的机械键盘到了', '晚上想吃火锅', '最近在追一部悬疑剧'];
    for (let i = 0; i < 200; i++) {
      const [id, username] = USERS[i % 3];
      const content = i % 5 === 4 ? '哈哈' : `${topics[i % topics.length]}（第${i}条）`;
      ingestMessage(ingestFixture({ authorId: id, username, createdAt: t0 + i * 60_000, content }));
    }
    const later = t0 + 200 * 60_000 + 3600_000;
    for (let round = 0; round < 10; round++) {
      if (scheduleDueWindows(later) === 0) break;
      await drainJobs(later);
    }
    const pending = getDatabase().query('SELECT COUNT(*) AS c FROM messages WHERE extracted_at IS NULL').get() as { c: number };
    expect(pending.c).toBe(0);
    for (const [id] of USERS.slice(0, 3)) {
      expect(listMemories({ scope: 'user', subjectId: id, limit: 500 }).length).toBeGreaterThan(30);
    }
    // 没说过话的 D 没有记忆；每个窗口一条 episode
    expect(listMemories({ scope: 'user', subjectId: D }).length).toBe(0);
    expect(listMemories({ scope: 'guild', subjectId: GUILD_ID, kinds: ['episode'] }).length).toBe(5);
    // 抽取请求里不包含 bot 的身份（它不是候选人）
    expect(fake.calls.every((c) => !c.user.includes(`用户ID ${SELF_ID}`))).toBe(true);
  });

  test('窗口里全是"哈哈""+1"时不调用 LLM，直接标记已处理', async () => {
    fake = installFakeLlm(() => '{}');
    const t = Date.now() - 3600_000;
    for (const [i, c] of ['哈哈', '+1', '？', '233'].entries()) ingestMessage(ingestFixture({ createdAt: t + i * 1000, content: c }));
    expect(hasSubstance(loadWindow(CHANNEL_ID, 40)!.messages)).toBe(false);
    await runExtractWindow(CHANNEL_ID, Date.now());
    expect(fake.calls).toHaveLength(0);
    expect((getDatabase().query('SELECT COUNT(*) AS c FROM messages WHERE extracted_at IS NULL').get() as { c: number }).c).toBe(0);
  });
});

describe('服务端校验', () => {
  test('各类 op 的接受与丢弃', async () => {
    const t = Date.now() - 600_000;
    const msgs = [
      ingestFixture({ authorId: A, username: 'awei', createdAt: t, content: '我叫阿伟，叫我伟哥就行，我住在杭州' }),
      ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t + 1000, content: `<@${A}> 伟哥今天又迟到了，大家都叫这个"阿伟时间"`, people: [personRef(A, '阿伟')] }),
      ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t + 2000, content: `听说 <@${A}> 有抑郁症`, people: [personRef(A, '阿伟')] }),
      ingestFixture({ authorId: A, username: 'awei', createdAt: t + 3000, content: '我的手机号 13812345678，搬到上海了' }),
    ];
    for (const m of msgs) ingestMessage(m);
    const existing = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟喜欢喝咖啡', origin: 'extractor' });
    const location = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'location', value: '杭州', content: '住在杭州', origin: 'extractor' });

    const sentiments: BotSentiment[] = [];
    const atmospheres: Atmosphere[] = [];
    onBotSentiment((e) => sentiments.push(...e));
    onAtmosphere((a) => atmospheres.push(a));

    fake = installFakeLlm(() =>
      JSON.stringify({
        episode: { summary: '阿伟和小红在聊迟到', importance: 3 },
        ops: [
          { op: 'set_slot', subject: A, slot: 'preferred_name', value: '伟哥', content: '希望被叫作伟哥', evidence: ['m1'] },
          { op: 'set_slot', subject: A, slot: 'preferred_name', value: '小伟', content: '别人觉得可以叫小伟', evidence: ['m2'] },
          { op: 'add', scope: 'user', subject: A, kind: 'alias', value: '伟哥', content: '小红叫阿伟"伟哥"', evidence: ['m2'] },
          { op: 'add', scope: 'user', subject: A, kind: 'fact', content: '阿伟有抑郁症', sensitive: true, evidence: ['m3'] },
          { op: 'add', scope: 'user', subject: A, kind: 'fact', content: '阿伟的手机号是 13812345678', evidence: ['m4'] },
          { op: 'add', scope: 'user', subject: '100000000000000099', kind: 'fact', content: '陌生人的事', evidence: ['m1'] },
          { op: 'add', scope: 'user', subject: A, kind: 'fact', content: '来自上文的信息', evidence: ['c1'] },
          { op: 'add', scope: 'guild', kind: 'meme', content: '群里把迟到叫作"阿伟时间"', importance: 6, evidence: ['m2'] },
          { op: 'add', scope: 'relation', subject: B, object: A, kind: 'relationship', content: '小红常吐槽阿伟迟到', evidence: ['m2'] },
          { op: 'add', scope: 'user', subject: A, kind: 'fact', content: '阿伟喜欢喝咖啡', evidence: ['m1'] },
          { op: 'update', id: existing.id, content: '阿伟喜欢喝咖啡，尤其是拿铁', evidence: ['m1'] },
          { op: 'supersede', id: location.id, content: '阿伟搬到了上海', value: '上海', evidence: ['m4'] },
          { op: 'add', scope: 'user', subject: A, kind: 'meme', content: '类型不对', evidence: ['m1'] },
        ],
        bot_sentiment: [
          { user: B, delta: -2, reason: '吐槽 bot', evidence: ['m2'] },
          { user: A, delta: 1, reason: '证据不是他说的', evidence: ['m2'] },
        ],
        atmosphere: { tone: '欢乐', valence: 0.5, arousal: 0.7 },
      })
    );

    const stats = (await runExtractWindow(CHANNEL_ID, Date.now()))!;
    expect(stats).toMatchObject({ added: 4, updated: 1, superseded: 1 });
    expect(stats.reasons).toEqual({
      'preferred-name-hearsay': 1,
      'sensitive-hearsay': 1,
      forbidden: 1,
      'unknown-subject': 1,
      'no-evidence': 1,
      duplicate: 1,
      'bad-kind': 1,
    });

    expect(activeSlot('user', A, 'preferred_name')).toMatchObject({ value: '伟哥', source_user_id: A, confidence: 0.9 });
    const alias = listMemories({ scope: 'user', subjectId: A, kinds: ['alias'] })[0];
    expect(alias).toMatchObject({ value: '伟哥', source_user_id: B });
    expect(alias.confidence).toBeLessThanOrEqual(0.6);
    expect(getMemory(existing.id)?.content).toBe('阿伟喜欢喝咖啡，尤其是拿铁');
    expect(activeSlot('user', A, 'location')).toMatchObject({ value: '上海', content: '阿伟搬到了上海' });
    expect(getMemory(location.id)?.status).toBe('superseded');
    expect(listMemories({ scope: 'relation', subjectId: A })[0]).toMatchObject({ subject_id: B, object_id: A });
    expect(listMemories({ scope: 'guild', subjectId: GUILD_ID }).map((m) => m.kind).sort()).toEqual(['episode', 'meme']);
    // 证据里记的是 Discord message_id
    expect(JSON.parse(activeSlot('user', A, 'preferred_name')!.evidence!)).toEqual([msgs[0].messageId]);

    expect(sentiments).toEqual([{ userId: B, delta: -2, reason: '吐槽 bot', messageId: msgs[1].messageId }]);
    expect(atmospheres).toEqual([{ tone: '欢乐', valence: 0.5, arousal: 0.7 }]);
  });

  test('候选人：作者、被 @ 的人、名字出现在文本里的人；不含 bot 自己与 optout 用户', () => {
    setOptOut(D, true);
    const t = Date.now();
    ingestMessage(ingestFixture({ authorId: A, username: 'awei', createdAt: t, content: `<@${D}> 和老王周末去爬山`, people: [personRef(D, '大大')] }));
    const w = loadWindow(CHANNEL_ID, 40)!;
    const cands = buildCandidates(w, SELF_ID, new Set([D]));
    expect(cands.map((c) => [c.id, c.role])).toEqual([
      [A, 'author'],
      [C, 'named'],
    ]);
  });

  test('隐私与称呼规则覆盖所有写入路径：supersede 改称呼要本人证据、取值字段过隐私检查、摘要不能带隐私、更新成敏感内容要打标记', async () => {
    const t = Date.now() - 600_000;
    const msgs = [
      ingestFixture({ authorId: A, username: 'awei', createdAt: t, content: '我最近确诊了焦虑症，在吃药' }),
      ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t + 1000, content: `<@${A}> 以后大家叫他笨蛋`, people: [personRef(A, '阿伟')] }),
    ];
    for (const m of msgs) ingestMessage(m);
    const pref = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'preferred_name', value: '伟哥', content: '希望被叫作伟哥', origin: 'user' });
    const health = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟最近压力很大', origin: 'extractor' });
    fake = installFakeLlm(() =>
      JSON.stringify({
        episode: { summary: '阿伟说自己确诊了焦虑症', importance: 3 },
        ops: [
          { op: 'supersede', id: pref.id, content: '大家叫他笨蛋', value: '笨蛋', evidence: ['m2'] },
          { op: 'add', scope: 'user', subject: A, kind: 'alias', value: '13812345678', content: '阿伟的新外号', evidence: ['m2'] },
          { op: 'update', id: health.id, content: '阿伟最近压力很大，确诊了焦虑症', evidence: ['m1'] },
        ],
        bot_sentiment: [],
        atmosphere: null,
      })
    );
    const stats = (await runExtractWindow(CHANNEL_ID, Date.now()))!;
    expect(stats.reasons).toMatchObject({ 'preferred-name-hearsay': 1, forbidden: 1, 'episode-private': 1 });
    expect(activeSlot('user', A, 'preferred_name')?.value).toBe('伟哥');
    expect(getMemory(health.id)).toMatchObject({ content: '阿伟最近压力很大，确诊了焦虑症', sensitive: 1 });
    expect(listMemories({ scope: 'guild', subjectId: GUILD_ID, includeSensitive: true })).toEqual([]);
  });

  test('模型自己标了敏感（正则认不出的病名）也算：别人转述的不记、不能进服务器记忆', async () => {
    const t = Date.now() - 600_000;
    const msgs = [ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t, content: `<@${A}> 最近查出来有糖尿病`, people: [personRef(A, '阿伟')] })];
    for (const m of msgs) ingestMessage(m);
    const plain = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟喜欢吃甜食', origin: 'extractor' });
    fake = installFakeLlm(() =>
      JSON.stringify({
        episode: null,
        ops: [
          { op: 'update', id: plain.id, content: '阿伟喜欢吃甜食，查出了糖尿病', sensitive: true, evidence: ['m1'] },
          { op: 'add', scope: 'guild', kind: 'topic', content: '群里在聊阿伟的糖尿病', sensitive: true, evidence: ['m1'] },
          { op: 'set_slot', subject: A, slot: 'occupation', value: '糖尿病患者', content: '职业：糖尿病患者', sensitive: true, evidence: ['m1'] },
        ],
        bot_sentiment: [],
        atmosphere: null,
      })
    );
    const stats = (await runExtractWindow(CHANNEL_ID, Date.now()))!;
    expect(stats.reasons).toMatchObject({ 'sensitive-hearsay': 2, 'sensitive-guild': 1 });
    expect(getMemory(plain.id)?.content).toBe('阿伟喜欢吃甜食');
  });

  test('只有别人转述作证据的更新：来源改成说话的人、置信度按转述处理', async () => {
    const t = Date.now() - 600_000;
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t, content: `<@${A}> 已经不当老师了，转行做程序员`, people: [personRef(A, '阿伟')] }));
    const job = addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿伟是老师', confidence: 0.9, origin: 'extractor', sourceUserId: A });
    fake = installFakeLlm(() => JSON.stringify({ episode: null, ops: [{ op: 'update', id: job.id, content: '阿伟转行做了程序员', evidence: ['m1'] }], bot_sentiment: [], atmosphere: null }));
    await runExtractWindow(CHANNEL_ID, Date.now());
    expect(getMemory(job.id)).toMatchObject({ content: '阿伟转行做了程序员', source_user_id: B });
    expect(getMemory(job.id)!.confidence).toBeLessThanOrEqual(0.6);
  });

  test('本人设置的感情状况不能被别人的转述取代（敏感 slot 的更新同样要本人证据）', async () => {
    const t = Date.now() - 600_000;
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t, content: `<@${A}> 早就结婚了`, people: [personRef(A, '阿伟')] }));
    const status = addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'relationship_status', value: '单身', content: '单身', sensitive: true, origin: 'user' });
    fake = installFakeLlm(() =>
      JSON.stringify({ episode: null, ops: [{ op: 'supersede', id: status.id, content: '已婚', value: '已婚', evidence: ['m1'] }], bot_sentiment: [], atmosphere: null })
    );
    const stats = (await runExtractWindow(CHANNEL_ID, Date.now()))!;
    expect(stats.reasons).toMatchObject({ 'sensitive-hearsay': 1 });
    expect(activeSlot('user', A, 'relationship_status')?.value).toBe('单身');
  });
});

describe('反复提炼失败的窗口（审查修复，第 10 轮）', () => {
  test('最后一次重试也失败：跳过这个窗口（标记已处理），频道后面的消息照常提炼；还能重试时窗口保留', async () => {
    const t = Date.now() - 3600_000;
    for (let i = 0; i < 10; i++) ingestMessage(ingestFixture({ authorId: A, username: 'awei', createdAt: t + i * 1000, content: `一段会被上游拒绝的内容 ${i}` }));
    fake = installFakeLlm(() => '抱歉，这个请求无法处理');
    const pending = (): number => (getDatabase().query('SELECT COUNT(*) AS c FROM messages WHERE extracted_at IS NULL').get() as { c: number }).c;
    expect(scheduleDueWindows(Date.now())).toBe(1);
    await drainJobs(Date.now());
    // 第一次失败：还会重试，窗口留着
    expect(pending()).toBe(10);
    getDatabase().run("UPDATE jobs SET attempts = ?, run_after = 0 WHERE type = 'extract_window'", [MAX_ATTEMPTS - 1]);
    await drainJobs(Date.now());
    expect(getDatabase().query("SELECT status FROM jobs WHERE type = 'extract_window'").get()).toEqual({ status: 'failed' });
    expect(pending()).toBe(0);
    // 之后的新消息照常进入新窗口
    fake.restore();
    fake = installFakeLlm(() => JSON.stringify({ episode: null, ops: [], bot_sentiment: [], atmosphere: null }));
    for (let i = 0; i < 10; i++) ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', createdAt: t + 60_000 + i * 1000, content: `后来的正常聊天 ${i}` }));
    expect(scheduleDueWindows(Date.now())).toBe(1);
    await drainJobs(Date.now());
    expect(pending()).toBe(0);
  });
});

describe('只供总结的消息（审查修复，第 11 轮）', () => {
  test('排队后改成"关掉观察、开着总结"：已排队的提炼任务不再执行、留在队列里；改回来后继续', async () => {
    const t = Date.now() - 3600_000;
    for (let i = 0; i < 10; i++) ingestMessage(ingestFixture({ authorId: A, username: 'awei', createdAt: t + i * 1000, content: `今天聊点正经事 ${i}` }));
    fake = installFakeLlm(() => JSON.stringify({ episode: null, ops: [], bot_sentiment: [], atmosphere: null }));
    expect(scheduleDueWindows(Date.now())).toBe(1);
    const cfg = getConfig().ai;
    cfg.memory.observe.enabled = false;
    cfg.summary = { ...cfg.summary, enabled: true };
    await drainJobs(Date.now());
    expect(fake.calls.length).toBe(0);
    expect(getDatabase().query("SELECT status FROM jobs WHERE type = 'extract_window'").get()).toEqual({ status: 'pending' });
    cfg.memory.observe.enabled = true;
    await drainJobs(Date.now());
    expect(fake.calls.length).toBe(1);
  });
});
