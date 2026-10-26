import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '../storage';
import { applyAffinityDelta, setImpression } from './affinity';
import { forgetUser, namesOf } from './forget';
import { isOptedOut, upsertMember, upsertUser, userExists } from './identity';
import { ingestDelete, ingestEdit, ingestMessage } from './ingest';
import { registerExtraction, runExtractWindow } from './memory/extract';
import { saveUserStats } from './memory/stats';
import { addMemory, getMemory, listMemories } from './memory/store';
import { applyMoodEvent } from './mood';
import { enqueueJob } from './worker';
import { upsertVector } from './vector/store';
import { CHANNEL_ID, GUILD_ID, SELF_ID, ingestFixture, installFakeLlm, memberInfo, personRef, setupAiTest, userInfo } from '../testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';
const HOUR = 3600_000;

registerExtraction();
let fake: ReturnType<typeof installFakeLlm> | null = null;

beforeEach(() => {
  setupAiTest({ memory: { enabled: true, extractor: { dailyTokenBudget: 0 } } });
  const now = Date.now();
  upsertUser(userInfo(A, 'awei', { globalName: 'Awei' }), now);
  upsertMember(memberInfo(A, { nickname: '阿伟' }), userInfo(A, 'awei', { globalName: 'Awei' }), now);
  upsertUser(userInfo(B, 'xiaohong'), now);
  upsertMember(memberInfo(B, { nickname: '小红' }), userInfo(B, 'xiaohong'), now);
});
afterEach(() => {
  fake?.restore();
  fake = null;
});

/** 全库扫描：所有普通表里，值包含 needle 的行（全文索引与向量索引的影子表除外） */
function rowsContaining(needle: string): Array<{ table: string; row: Record<string, unknown> }> {
  const db = getDatabase();
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'vec_bin_%'")
    .all() as Array<{ name: string }>;
  const hits: Array<{ table: string; row: Record<string, unknown> }> = [];
  for (const { name } of tables) {
    for (const row of db.query(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) {
      const text = Object.values(row)
        .map((v) => (v instanceof Uint8Array ? '' : String(v ?? '')))
        .join('\u0001');
      if (text.includes(needle)) hits.push({ table: name, row });
    }
  }
  return hits;
}

/** 造一个数据很全的用户 A，以及和 A 有关的别人的数据 */
function seed(): { aMsg: string; bMention: string; bPlain: string; bMemory: number } {
  const db = getDatabase();
  const t = Date.now() - 2 * HOUR;
  const a1 = ingestFixture({ authorId: A, username: 'awei', nickname: '阿伟', createdAt: t, content: '我在准备考研究生，目标是浙江大学' });
  const a2 = ingestFixture({ authorId: A, username: 'awei', nickname: '阿伟', createdAt: t + 1000, content: `<@${B}> 你也考吗`, people: [personRef(B, '小红')] });
  const bMention = ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t + 2000, content: `<@${A}> 我不考，加油`, people: [personRef(A, '阿伟')] });
  const bPlain = ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t + 3000, content: '阿伟今天好努力' });
  const botReply = ingestFixture({ authorId: SELF_ID, username: 'memecat', kind: 'bot_ai', createdAt: t + 4000, content: '阿伟加油喵', replyToId: a1.messageId });
  for (const m of [a1, a2, bMention, bPlain, botReply]) ingestMessage(m, { forceKind: true });
  // 旧版数据：一对一对话的虚拟频道、还没绑定 ID 的旧频道消息、旧表
  db.run(
    "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text, created_at, source) VALUES ('legacy-conv-1', '', 'legacy-dm:awei', 'legacy:awei', 'awei', 'user', '旧对话', '旧对话', ?, 'legacy')",
    [t - HOUR]
  );
  db.run(
    "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text, created_at, source) VALUES ('legacy-cm-1', '', ?, NULL, '阿伟', 'user', '旧频道消息', '旧频道消息', ?, 'legacy')",
    [CHANNEL_ID, t - HOUR]
  );
  db.run('CREATE TABLE _legacy_ai_conversations (id INTEGER PRIMARY KEY, platform TEXT, username TEXT, role TEXT, content TEXT, created_at INTEGER)');
  db.run("INSERT INTO _legacy_ai_conversations (platform, username, role, content, created_at) VALUES ('discord', 'awei', 'user', '旧', 1), ('discord', 'xiaohong', 'user', '旧', 1)");
  db.run('CREATE TABLE _legacy_channel_messages (id INTEGER PRIMARY KEY, author TEXT, content TEXT)');
  db.run("INSERT INTO _legacy_channel_messages (author, content) VALUES ('阿伟', '旧'), ('小红', '旧')");

  // 记忆
  const own = addMemory({ scope: 'user', subjectId: A, kind: 'plan', content: '阿伟在准备考研', importance: 9, origin: 'extractor', evidence: [a1.messageId] });
  addMemory({ scope: 'user', subjectId: A, kind: 'alias', value: '伟哥', content: '大家叫他伟哥', origin: 'extractor' });
  addMemory({ scope: 'relation', subjectId: A, objectId: B, kind: 'relationship', content: '和小红是同学', origin: 'extractor' });
  addMemory({ scope: 'relation', subjectId: B, objectId: A, kind: 'relationship', content: '小红常鼓励他', origin: 'extractor' });
  addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'episode', content: '伟哥和小红聊考研', origin: 'extractor' });
  addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'rule', content: '群规：不许刷屏', origin: 'extractor', sourceUserId: A });
  addMemory({ scope: 'self', subjectId: 'memecat', kind: 'promise', content: '答应了 Awei 考完一起打游戏', origin: 'appraisal' });
  const bMemory = addMemory({
    scope: 'user',
    subjectId: B,
    kind: 'fact',
    content: '小红不考研',
    origin: 'extractor',
    sourceUserId: A,
    evidence: [a2.messageId, bMention.messageId],
  }).id;
  upsertVector('memory', own.id, `user:${A}`, 'user', 'test-model', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
  upsertVector('memory', bMemory, `user:${B}`, 'user', 'test-model', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));

  // 画像、关系、好感、情绪、统计、在线活动、任务
  const now = Date.now();
  db.run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('user', ?, '阿伟是个考研党', 0, 'm', ?)", [A, now]);
  db.run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('guild', ?, '活跃成员有阿伟和小红', 0, 'm', ?)", [GUILD_ID, now]);
  db.run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('guild', '800000000000000009', '另一个群', 0, 'm', ?)", [now]);
  applyAffinityDelta(A, 3, '夸了 bot', 'appraisal', { now });
  applyAffinityDelta(B, 2, '和阿伟一起夸 bot', 'appraisal', { now, category: 'x' });
  setImpression(B, '阿伟的好朋友', now);
  applyMoodEvent(null, 0.1, 0, '阿伟夸我', 'interaction', { userId: A, now });
  applyMoodEvent(null, 0.05, 0, '阿伟和小红在聊天', 'atmosphere', { guildId: GUILD_ID, now });
  saveUserStats(A, GUILD_ID, { messages: 2 } as never, now);
  db.run("INSERT INTO activity_sessions (user_id, type, name, details, started_at, ended_at) VALUES (?, 'playing', '原神', NULL, ?, ?)", [A, now - HOUR, now]);
  enqueueJob('appraise', { userId: A, guildId: GUILD_ID }, {}, now);
  enqueueJob('refresh_profile', { scope: 'user', subjectId: B }, {}, now);
  return { aMsg: a1.messageId, bMention: bMention.messageId, bPlain: bPlain.messageId, bMemory };
}

describe('/forget-me', () => {
  test('删除后全库找不到 ta 的 ID；别人的数据保留但被匿名化', () => {
    const s = seed();
    expect(rowsContaining(A).length).toBeGreaterThan(10);
    expect(namesOf(A).all).toEqual(expect.arrayContaining(['awei', 'Awei', '阿伟', '伟哥']));

    const r = forgetUser(A);
    expect(r.messages).toBe(4); // 两条本人消息 + 旧对话 + 旧频道消息
    expect(r.botReplies).toBe(1);
    expect(r.scrubbedMessages).toBe(1);
    expect(r.vectors).toBe(1);

    expect(rowsContaining(A)).toEqual([]);
    expect(userExists(A)).toBe(false);

    const db = getDatabase();
    // 别人 @ 过 ta 的消息：@ 改成"@已删除的用户"，原文与渲染文本都改；不带 @ 提到名字的别人的发言不改
    const mention = db.query('SELECT content_raw, content_text, mentions FROM messages WHERE message_id = ?').get(s.bMention) as Record<string, string | null>;
    expect(mention).toEqual({ content_raw: '@已删除的用户 我不考，加油', content_text: '@已删除的用户 我不考，加油', mentions: null });
    expect((db.query('SELECT content_text FROM messages WHERE message_id = ?').get(s.bPlain) as { content_text: string }).content_text).toBe('阿伟今天好努力');
    // 全文索引里也搜不到 ta 的消息
    expect(db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '考研究生'").all()).toEqual([]);
    // 名字只剩在那条别人的原话里
    for (const name of ['阿伟', '伟哥', 'Awei', 'awei']) {
      const hits = rowsContaining(name).filter((h) => !(h.table === 'messages' && h.row.message_id === s.bPlain));
      expect(hits.map((h) => h.table)).toEqual([]);
    }

    // 别人的数据还在
    const bMem = db.query('SELECT source_user_id, evidence FROM memories WHERE id = ?').get(s.bMemory) as { source_user_id: string | null; evidence: string };
    expect(bMem.source_user_id).toBeNull();
    expect(JSON.parse(bMem.evidence)).toEqual([s.bMention]);
    // 只是提到 TA 名字的共享记忆：名字匿名化，不整条删除（名字匹配不可靠，删除只认来源 / 证据关联）；信息来源是 TA 的整条删除
    expect(listMemories({ scope: 'guild', subjectId: GUILD_ID, includeSensitive: true, limit: 10 }).map((m) => m.content)).toEqual(['某人和小红聊考研']);
    expect((db.query('SELECT impression FROM relationships WHERE user_id = ?').get(B) as { impression: string }).impression).toBe('某人的好朋友');
    expect((db.query('SELECT reason FROM affinity_events WHERE user_id = ?').get(B) as { reason: string }).reason).toBe('和某人一起夸 bot');
    expect(db.query('SELECT COUNT(*) AS c FROM messages WHERE author_id = ?').get(B)).toEqual({ c: 2 });
    expect(db.query('SELECT COUNT(*) AS c FROM vectors').get()).toEqual({ c: 1 });
    expect(db.query("SELECT COUNT(*) AS c FROM profiles WHERE scope = 'guild'").get()).toEqual({ c: 1 });
    expect(db.query('SELECT COUNT(*) AS c FROM _legacy_ai_conversations').get()).toEqual({ c: 1 });
    expect(db.query('SELECT COUNT(*) AS c FROM jobs').get()).toEqual({ c: 1 });
    expect(userExists(B)).toBe(true);
  });

  test('"删除并且以后不再记录"：只留下一个空的退出标记，之后的消息不再入库', () => {
    seed();
    forgetUser(A, { keepOptOut: true });
    const rows = rowsContaining(A);
    expect(rows.map((h) => h.table)).toEqual(['users']);
    expect(rows[0].row).toMatchObject({ user_id: A, username: '', global_name: null, avatar_url: null });
    expect(isOptedOut(A)).toBe(true);
    expect(ingestMessage(ingestFixture({ authorId: A, username: 'awei', content: '又来了' }))).toBe('skipped');
  });

  test('之后再说话会重新认识（缓存不会以为资料还在）', () => {
    seed();
    forgetUser(A);
    expect(ingestMessage(ingestFixture({ authorId: A, username: 'awei', content: '我回来了' }))).toBe('inserted');
    expect(userExists(A)).toBe(true);
  });

  test('抽取进行到一半时 ta 执行了 /forget-me：模型返回后不再写入关于 ta 的任何东西', async () => {
    const t = Date.now() - HOUR;
    ingestMessage(ingestFixture({ authorId: A, username: 'awei', nickname: '阿伟', createdAt: t, content: '我下周三要去面试字节跳动' }));
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t + 1000, content: `<@${A}> 加油！`, people: [personRef(A, '阿伟')] }));
    fake = installFakeLlm(() => {
      forgetUser(A);
      return JSON.stringify({
        episode: { summary: '阿伟要去面试', importance: 3 },
        ops: [
          { op: 'add', scope: 'user', subject: A, kind: 'plan', content: '阿伟下周三面试字节', evidence: ['m1'] },
          { op: 'add', scope: 'relation', subject: B, object: A, kind: 'relationship', content: '小红给阿伟打气', evidence: ['m2'] },
        ],
        bot_sentiment: [],
        atmosphere: null,
      });
    });
    // 整个窗口放弃（任务稍后按退避重做），什么都不写
    await expect(runExtractWindow(CHANNEL_ID, Date.now())).rejects.toThrow('有数据被删除');
    expect(rowsContaining(A)).toEqual([]);
    expect(rowsContaining('阿伟')).toEqual([]);
    // 重做时 TA 的消息已经不在了，也不会再出现 TA
    fake?.restore();
    fake = installFakeLlm(() => JSON.stringify({ episode: null, ops: [], bot_sentiment: [], atmosphere: null }));
    await runExtractWindow(CHANNEL_ID, Date.now());
    expect(rowsContaining(A)).toEqual([]);
  });

  test('删除墓碑：历史回望再拉到 TA 删除前的消息（以及 bot 对它们的回复）不会导回来；删除之后的新消息照常记录', () => {
    const old = ingestFixture({ authorId: A, username: 'awei', createdAt: Date.now() - 2 * HOUR, content: '我住在杭州西湖边', source: 'backfill' });
    ingestMessage(old);
    forgetUser(A);
    expect(ingestMessage(old)).toBe('skipped');
    const botReply = ingestFixture({
      authorId: SELF_ID,
      username: 'memecat',
      kind: 'bot_ai',
      content: '西湖边不错',
      replyToId: old.messageId,
      replyToAuthorId: A,
      source: 'backfill',
    });
    expect(ingestMessage(botReply, { forceKind: true })).toBe('skipped');
    expect(rowsContaining(A)).toEqual([]);
    // 墓碑只存加盐哈希
    expect(getDatabase().query('SELECT COUNT(*) AS c FROM forgotten_users').get()).toEqual({ c: 1 });
    expect(ingestMessage(ingestFixture({ authorId: A, username: 'awei', createdAt: Date.now() + 1000, content: '我又回来了' }))).toBe('inserted');
  });

  test('认领旧数据只用 TA 独有的名字：把称呼设成别人的名字再删除，不会删掉那个人的旧消息和相关记忆', () => {
    const C = '100000000000000003';
    upsertUser(userInfo(C, 'zhangsan'), Date.now());
    upsertMember(memberInfo(C, { nickname: '张三' }), userInfo(C, 'zhangsan'), Date.now());
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'preferred_name', value: '张三', content: '希望被叫作张三', origin: 'user' });
    const db = getDatabase();
    db.run(
      "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text, created_at, source) VALUES ('legacy-cm-9', '', ?, NULL, '张三', 'user', '张三的旧消息', '张三的旧消息', ?, 'legacy')",
      [CHANNEL_ID, Date.now() - HOUR]
    );
    addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'episode', content: '张三分享了旅行照片', origin: 'extractor' });
    expect(namesOf(A).all).not.toContain('张三');
    forgetUser(A);
    expect(db.query("SELECT COUNT(*) AS c FROM messages WHERE message_id = 'legacy-cm-9'").get()).toEqual({ c: 1 });
    expect(listMemories({ scope: 'guild', subjectId: GUILD_ID, includeSensitive: true, limit: 10 }).map((m) => m.content)).toEqual(['张三分享了旅行照片']);
  });
});

describe('/forget-me 防回灌（审查修复，第 2 轮）', () => {
  test('直接发到频道的插话（没有回复引用）被连带删除后，回望再拉到也不会导回来', () => {
    const a1 = ingestFixture({ authorId: A, username: 'awei', createdAt: Date.now() - HOUR, content: '我在准备考研' });
    ingestMessage(a1);
    const interjection = ingestFixture({
      authorId: SELF_ID,
      username: 'memecat',
      kind: 'bot_ai',
      proactive: true,
      createdAt: Date.now() - HOUR + 1000,
      content: '考研加油，阿伟',
      replyToId: a1.messageId,
      replyToAuthorId: A,
    });
    ingestMessage(interjection, { forceKind: true });
    forgetUser(A);
    // 回望拉到的是 Discord 上的原样：没有回复引用，只能按消息 ID 认出来
    const refetched = { ...interjection, kind: 'bot_other' as const, proactive: undefined, replyToId: null, replyToAuthorId: null, source: 'backfill' as const };
    expect(ingestMessage(refetched)).toBe('skipped');
    expect(rowsContaining('考研')).toEqual([]);
  });

  test('删除前别人写的、当时没入库的消息被补拉进来：对 TA 的 @ 匿名化，不记互动关系', () => {
    forgetUser(A);
    const old = ingestFixture({
      authorId: B,
      username: 'xiaohong',
      createdAt: Date.now() - 2 * HOUR,
      content: `<@${A}> 生日快乐`,
      people: [personRef(A, '阿伟')],
      source: 'backfill',
    });
    expect(ingestMessage(old)).toBe('inserted');
    expect(rowsContaining(A)).toEqual([]);
    expect(getDatabase().query('SELECT content_text FROM messages WHERE message_id = ?').get(old.messageId)).toEqual({ content_text: '@已删除的用户 生日快乐' });
  });

  test('别人的统计里嵌着 TA 的 ID 也会被清掉（下次重算）；执行中的任务载荷一并删除', () => {
    saveUserStats(B, GUILD_ID, { messages: 3, topPartners: [{ id: A, name: '阿伟', count: 3 }] } as never, Date.now());
    const job = enqueueJob('appraise', { userId: A, guildId: GUILD_ID }, {}, Date.now())!;
    getDatabase().run("UPDATE jobs SET status = 'running' WHERE id = ?", [job]);
    forgetUser(A);
    expect(rowsContaining(A)).toEqual([]);
  });
});

describe('/forget-me（审查修复，第 3 轮）', () => {
  test('关系另一方的画像随之失效；执行中的任务只清空载荷、保留编号（不会被新任务复用）', () => {
    addMemory({ scope: 'relation', subjectId: B, objectId: A, kind: 'relationship', content: '小红和阿伟是同学', origin: 'extractor' });
    getDatabase().run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('user', ?, '小红有个同学', 0, 'm', ?)", [B, Date.now()]);
    const job = enqueueJob('appraise', { userId: A, userMessageId: 'x' }, {}, Date.now())!;
    getDatabase().run("UPDATE jobs SET status = 'running' WHERE id = ?", [job]);
    forgetUser(A);
    expect(getDatabase().query("SELECT COUNT(*) AS c FROM profiles WHERE subject_id = ?").get(B)).toEqual({ c: 0 });
    expect(getDatabase().query('SELECT status, payload FROM jobs WHERE id = ?').get(job)).toEqual({ status: 'running', payload: '{}' });
    expect(rowsContaining(A)).toEqual([]);
  });

  test('别人编辑删除前的旧消息：匿名化过的 @ 不会借编辑写回来', () => {
    const msg = ingestFixture({ authorId: B, username: 'xiaohong', createdAt: Date.now() - HOUR, content: `<@${A}> 生日快乐`, people: [personRef(A, '阿伟')] });
    ingestMessage(msg);
    forgetUser(A);
    const edited = ingestFixture({ messageId: msg.messageId, authorId: B, username: 'xiaohong', createdAt: msg.createdAt, content: `<@${A}> 生日快乐！！`, people: [personRef(A, '阿伟')] });
    expect(ingestEdit(msg.messageId, edited.contentRaw, edited.rendered, Date.now())).toBe(true);
    expect(rowsContaining(A)).toEqual([]);
    expect(getDatabase().query('SELECT content_text FROM messages WHERE message_id = ?').get(msg.messageId)).toEqual({ content_text: '@已删除的用户 生日快乐！！' });
  });
});

describe('/forget-me（审查修复，第 5 轮）', () => {
  test('把称呼设成"群规"再删除：不会删掉含"群规"的共享记忆；证据来自 TA 消息的共享记忆才整条删除', () => {
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', slot: 'preferred_name', value: '群规', content: '希望被叫作群规', origin: 'user' });
    const rule = addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'rule', content: '群规：禁止刷屏', origin: 'extractor' });
    const mine = ingestFixture({ authorId: A, username: 'awei', createdAt: Date.now() - HOUR, content: '我们下周组织去爬山' });
    ingestMessage(mine);
    const event = addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'event', content: '下周组织爬山', origin: 'extractor', evidence: [mine.messageId] });
    forgetUser(A);
    expect(listMemories({ scope: 'guild', subjectId: GUILD_ID, includeSensitive: true, limit: 10 }).map((m) => m.id)).toEqual([rule.id]);
    expect(event.id).not.toBe(rule.id);
  });

  test('升级前的旧消息里别人对 TA 的 @（只存了 "@显示名" 文本）也匿名化', () => {
    getDatabase().run(
      "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text, created_at, source) VALUES ('legacy-cm-7', '', ?, NULL, '小红', 'user', '@阿伟 加油', '@阿伟 加油', ?, 'legacy')",
      [CHANNEL_ID, Date.now() - HOUR]
    );
    forgetUser(A);
    expect(getDatabase().query("SELECT content_text, content_raw FROM messages WHERE message_id = 'legacy-cm-7'").get()).toEqual({
      content_text: '@已删除的用户 加油',
      content_raw: '@已删除的用户 加油',
    });
  });
});

describe('/forget-me（审查修复，第 6 轮）', () => {
  test('TA 先删掉了自己的原消息再删除：bot 对 TA 的回复照样删掉', () => {
    const t = Date.now() - HOUR;
    const mine = ingestFixture({ authorId: A, username: 'awei', createdAt: t, content: '@memecat 我下个月去东京出差' });
    ingestMessage(mine);
    const reply = ingestFixture({ authorId: SELF_ID, username: 'memecat', kind: 'bot_ai', createdAt: t + 3000, content: '东京出差记得带伞喵', replyToId: mine.messageId, replyToAuthorId: A });
    ingestMessage(reply, { forceKind: true });
    expect(ingestDelete(mine.messageId)).toBe(true);
    forgetUser(A);
    expect(rowsContaining('东京')).toEqual([]);
  });

  test('信息来源是 TA 的共享记忆整条删除（证据消息已过保留期）；和 TA 聊天得出的 bot 自我记忆一并删除', () => {
    const guildMem = addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'event', content: '下周六组织去爬山', origin: 'extractor', sourceUserId: A, evidence: ['purged-1'] });
    const t = Date.now() - HOUR;
    const reply = ingestFixture({ authorId: SELF_ID, username: 'memecat', kind: 'bot_ai', createdAt: t, content: '好的周五提醒你喵', replyToAuthorId: A });
    ingestMessage(reply, { forceKind: true });
    const promise = addMemory({ scope: 'self', subjectId: 'memecat', guildId: GUILD_ID, kind: 'promise', content: '答应周五提醒对方交作业', origin: 'appraisal', evidence: [reply.messageId] });
    const other = addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'rule', content: '禁止刷屏', origin: 'extractor', sourceUserId: B });
    forgetUser(A);
    expect(getMemory(guildMem.id)).toBeNull();
    expect(getMemory(promise.id)).toBeNull();
    expect(getMemory(other.id)).not.toBeNull();
  });

  test('别人的反思特点里提到 TA：随画像一起失效（不会在重新生成画像时被读回去）', () => {
    const trait = addMemory({ scope: 'user', subjectId: B, kind: 'trait', content: '经常和阿伟一起开黑', origin: 'reflection' });
    const pinned = addMemory({ scope: 'user', subjectId: B, kind: 'trait', content: '嘴硬心软', origin: 'reflection', pinned: true });
    forgetUser(A);
    expect(getMemory(trait.id)).toBeNull();
    expect(getMemory(pinned.id)).not.toBeNull();
  });
});

describe('/forget-me（审查修复，第 7 轮）', () => {
  test('删掉来源是 TA 的服务器 / 自我记忆：对应画像失效，即使画像里没写 TA 的名字', () => {
    addMemory({ scope: 'guild', subjectId: GUILD_ID, guildId: GUILD_ID, kind: 'event', content: '周五有人去东京面试', origin: 'extractor', sourceUserId: A });
    addMemory({ scope: 'self', subjectId: 'memecat', guildId: GUILD_ID, kind: 'promise', content: '答应帮对方准备东京面试', origin: 'appraisal', sourceUserId: A });
    const db = getDatabase();
    for (const [scope, subject] of [['guild', GUILD_ID], ['self', 'memecat'], ['guild', '999']]) {
      db.run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES (?, ?, '最近在帮对方准备东京的面试', 0, 'm', 1)", [scope, subject]);
    }
    forgetUser(A);
    expect(db.query('SELECT scope, subject_id FROM profiles ORDER BY scope').all()).toEqual([{ scope: 'guild', subject_id: '999' }]);
  });
});

describe('/forget-me（审查修复，第 9 轮）', () => {
  test('窗口摘要里有 TA 在中间说的事（首尾消息都是别人的）：整条删除，不只是换名字', async () => {
    const t = Date.now() - HOUR;
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t, content: '周五大家都干嘛' }));
    ingestMessage(ingestFixture({ authorId: A, username: 'awei', nickname: '阿伟', createdAt: t + 1000, content: '我周五去东京面试' }));
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t + 2000, content: '加油！' }));
    fake = installFakeLlm(() => JSON.stringify({ episode: { summary: '阿伟周五去东京面试，大家为他加油', importance: 3 }, ops: [], bot_sentiment: [], atmosphere: null }));
    await runExtractWindow(CHANNEL_ID, Date.now());
    expect(rowsContaining('东京').map((r) => r.table)).toContain('memories');
    forgetUser(A);
    expect(rowsContaining('东京')).toEqual([]);
  });
});

describe('/forget-me（审查修复，第 10 轮）', () => {
  test('原消息已经没了（本人删掉 / 过了保留期）：TA 参与过的窗口摘要和服务器记忆照样整条删除', async () => {
    const t = Date.now() - HOUR;
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t, content: '周五大家都干嘛' }));
    const mine = ingestFixture({ authorId: A, username: 'awei', nickname: '阿伟', createdAt: t + 1000, content: '我周五去东京面试，顺便组织个聚会' });
    ingestMessage(mine);
    ingestMessage(ingestFixture({ authorId: B, username: 'xiaohong', nickname: '小红', createdAt: t + 2000, content: '加油！' }));
    fake = installFakeLlm(() =>
      JSON.stringify({
        episode: { summary: '有人周五去东京面试，大家为他加油', importance: 3 },
        ops: [{ op: 'add', scope: 'guild', kind: 'event', content: '周五在东京有个聚会', evidence: ['m2', 'm3'] }],
        bot_sentiment: [],
        atmosphere: null,
      })
    );
    await runExtractWindow(CHANNEL_ID, Date.now());
    expect(rowsContaining('东京').filter((r) => r.table === 'memories').length).toBe(2);
    // 原消息全部被清理（保留期 / 本人删除）
    getDatabase().run('DELETE FROM messages');
    forgetUser(A);
    expect(rowsContaining('东京')).toEqual([]);
  });
});
