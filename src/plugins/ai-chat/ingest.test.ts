import { beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '@/storage';
import { bindLegacyIdentity, getMember, getUser, isOptedOut, pendingLegacyUsernames, setOptOut, snowflakeTime, upsertUser } from './identity';
import { ingestDelete, ingestEdit, ingestMessage, recordReaction, skipReason } from './ingest';
import { getStoredMessage, parseStoredMentions } from './messages';
import { renderDiscordContent } from './mentions';
import { GUILD_ID, SELF_ID, ingestFixture, personRef, resolverOf, setupAiTest, snowflakeAt, userInfo } from '@/testing/fixtures';

const ALICE = '100000000000000001';
const BOB = '100000000000000002';

function nameHistory(userId: string): Array<{ kind: string; value: string }> {
  return getDatabase().query('SELECT kind, value FROM name_history WHERE user_id = ? ORDER BY id').all(userId) as Array<{ kind: string; value: string }>;
}

function edge(from: string, to: string): { mentions: number; replies: number; reactions: number } | null {
  return getDatabase()
    .query('SELECT mentions, replies, reactions FROM interaction_edges WHERE guild_id = ? AND from_user_id = ? AND to_user_id = ?')
    .get(GUILD_ID, from, to) as { mentions: number; replies: number; reactions: number } | null;
}

beforeEach(() => setupAiTest());

describe('snowflakeTime', () => {
  test('从 ID 推出创建时间', () => {
    const t = Date.UTC(2024, 0, 1);
    expect(snowflakeTime(snowflakeAt(t))).toBe(t);
    expect(snowflakeTime('not-a-number')).toBe(0);
  });
});

describe('ingestMessage', () => {
  test('入库消息并建立用户、成员、频道、服务器记录', () => {
    const m = ingestFixture({ content: '大家好', nickname: '小A' });
    expect(ingestMessage(m)).toBe('inserted');
    const row = getStoredMessage(m.messageId)!;
    expect(row).toMatchObject({ author_id: ALICE, author_name: '小A', content_text: '大家好', msg_kind: 'user', guild_id: GUILD_ID });
    expect(getUser(ALICE)?.username).toBe('alice');
    expect(getMember(GUILD_ID, ALICE)).toMatchObject({ nickname: '小A', display_name: '小A', message_count: 1 });
    expect(getDatabase().query('SELECT name FROM channels').get()).toEqual({ name: '闲聊' });
    expect(getDatabase().query('SELECT name FROM guilds').get()).toEqual({ name: '测试服' });
  });

  test('同一条消息重复入库不重复计数', () => {
    const m = ingestFixture();
    ingestMessage(m);
    expect(ingestMessage(m)).toBe('unchanged');
    expect(getMember(GUILD_ID, ALICE)?.message_count).toBe(1);
  });

  test('改名后发言：资料更新，曾用名记入 name_history', () => {
    const t0 = Date.now() - 3600_000;
    ingestMessage(ingestFixture({ createdAt: t0, username: 'alice', nickname: '小A' }));
    ingestMessage(ingestFixture({ createdAt: t0 + 1000, username: 'alice_new', nickname: '阿丽' }));
    expect(getUser(ALICE)?.username).toBe('alice_new');
    expect(getMember(GUILD_ID, ALICE)?.nickname).toBe('阿丽');
    expect(nameHistory(ALICE)).toEqual([
      { kind: 'username', value: 'alice' },
      { kind: 'nick', value: '小A' },
      { kind: 'username', value: 'alice_new' },
      { kind: 'nick', value: '阿丽' },
    ]);
  });

  test('历史回望的旧消息没有成员数据时不覆盖已有昵称，但更新首次出现时间', () => {
    const now = Date.now();
    ingestMessage(ingestFixture({ createdAt: now, nickname: '小A' }));
    ingestMessage(ingestFixture({ createdAt: now - 86400_000 * 10, source: 'backfill' }));
    const member = getMember(GUILD_ID, ALICE)!;
    expect(member.nickname).toBe('小A');
    expect(member.first_seen_at).toBe(now - 86400_000 * 10);
    expect(getUser(ALICE)?.first_seen_at).toBe(now - 86400_000 * 10);
  });

  test('bot 自己的 AI 回复先被当成普通发言入库后，会被纠正为 bot_ai', () => {
    const m = ingestFixture({ authorId: SELF_ID, username: 'memecat', kind: 'bot_other', content: '喵' });
    expect(ingestMessage(m)).toBe('inserted');
    expect(ingestMessage({ ...m, kind: 'bot_ai' }, { forceKind: true })).toBe('updated');
    expect(getStoredMessage(m.messageId)?.msg_kind).toBe('bot_ai');
    expect(getUser(SELF_ID)?.is_self).toBe(1);
    // bot 自己的发言不计入发言数
    expect(getMember(GUILD_ID, SELF_ID)?.message_count).toBe(0);
  });

  test('过滤：其他 bot、optout 用户、黑名单频道、未允许的服务器', () => {
    const otherBot = ingestFixture({ authorId: '100000000000000009' });
    otherBot.author.user.isBot = true;
    expect(skipReason(otherBot)).toBe('other-bot');

    upsertUser(userInfo(BOB, 'bob'), Date.now());
    setOptOut(BOB, true);
    expect(skipReason(ingestFixture({ authorId: BOB, username: 'bob' }))).toBe('opted-out');
    expect(isOptedOut(BOB)).toBe(true);

    setupAiTest({ memory: { enabled: true, observe: { channelDenylist: ['700000000000000001'] } } });
    expect(skipReason(ingestFixture())).toBe('channel-denylisted');
    const inThread = ingestFixture({ channel: { channelId: '700000000000000099', guildId: GUILD_ID, parentId: '700000000000000001', name: 't', type: 'thread' } });
    expect(skipReason(inThread)).toBe('channel-denylisted');

    setupAiTest({ allowedGuildIds: ['800000000000000999'] });
    expect(ingestMessage(ingestFixture())).toBe('skipped');

    setupAiTest({ enabled: false });
    expect(skipReason(ingestFixture())).toBe('disabled');
  });

  test('@ 与回复会累加互动边；mentions 以紧凑形式入库', () => {
    const people = [personRef(BOB, '小B')];
    const m = ingestFixture({ content: `<@${BOB}> 看这个`, people, replyToAuthorId: BOB });
    ingestMessage(m);
    expect(edge(ALICE, BOB)).toEqual({ mentions: 1, replies: 1, reactions: 0 });
    expect(parseStoredMentions(getStoredMessage(m.messageId)!.mentions)).toEqual([{ t: 'user', id: BOB, name: '小B' }]);
    expect(getStoredMessage(m.messageId)!.content_text).toBe('@小B 看这个');
  });

  test('表情反应：记为反应者 → 作者的互动，并返回被反应消息的信息', () => {
    const m = ingestFixture();
    ingestMessage(m);
    const reacted = recordReaction(GUILD_ID, m.messageId, userInfo(BOB, 'bob'), Date.now());
    expect(reacted).toEqual({ authorId: ALICE, kind: 'user', proactive: false, channelId: m.channel.channelId });
    expect(edge(BOB, ALICE)?.reactions).toBe(1);
    expect(recordReaction(GUILD_ID, '1', userInfo(BOB, 'bob'), Date.now())).toBeNull();
  });

  test('编辑与删除同步到库（含全文索引）', () => {
    const m = ingestFixture({ content: '原来的内容' });
    ingestMessage(m);
    const edited = renderDiscordContent('改过的内容', resolverOf([]));
    expect(ingestEdit(m.messageId, '改过的内容', edited, Date.now())).toBe(true);
    const fts = () => getDatabase().query("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH '改过的'").get() as { c: number };
    expect(fts().c).toBe(1);
    expect(ingestDelete(m.messageId)).toBe(true);
    expect(getStoredMessage(m.messageId)).toBeNull();
    expect(fts().c).toBe(0);
  });
});

describe('旧数据身份绑定', () => {
  test('legacy:<username> 在第一次见到同名用户时绑定到真实 ID', () => {
    const db = getDatabase();
    db.run(
      "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, content_raw, content_text, created_at, source) VALUES ('legacy-conv-1', '', 'legacy-dm:alice', 'legacy:alice', 'alice', 'hi', 'hi', 1, 'legacy')"
    );
    expect(pendingLegacyUsernames()).toEqual(['alice']);
    ingestMessage(ingestFixture({ username: 'alice' }));
    expect(getStoredMessage('legacy-conv-1')?.author_id).toBe(ALICE);
    expect(pendingLegacyUsernames()).toEqual([]);
    expect(bindLegacyIdentity(ALICE, 'alice')).toBe(false);
  });

  test('旧身份和真实 ID 下有同一个 slot（先用了 /callme）：新值保留、旧值转为历史，消息照常入库', () => {
    const db = getDatabase();
    upsertUser(userInfo(ALICE, 'alice'), Date.now());
    const insert = "INSERT INTO memories (scope, subject_id, kind, slot, value, content, importance, confidence, origin, created_at, updated_at) VALUES ('user', ?, 'fact', 'preferred_name', ?, ?, 5, 0.8, ?, 1, 1)";
    db.run(insert, ['legacy:alice', '小爱', '希望被叫作小爱', 'legacy']);
    db.run(insert, [ALICE, '阿丽', '希望被叫作阿丽', 'user']);
    expect(ingestMessage(ingestFixture({ username: 'alice' }))).toBe('inserted');
    const rows = db.query("SELECT value, status FROM memories WHERE subject_id = ? AND slot = 'preferred_name' ORDER BY id").all(ALICE);
    expect(rows).toEqual([
      { value: '小爱', status: 'superseded' },
      { value: '阿丽', status: 'active' },
    ]);
    expect(pendingLegacyUsernames()).toEqual([]);
  });

  test('旧的频道消息（无作者 ID、无服务器）被历史回望拉到时修复', () => {
    const t = Date.now() - 1000;
    const id = snowflakeAt(t);
    getDatabase().run(
      "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, content_raw, content_text, created_at, source) VALUES (?, '', ?, NULL, '小A', '旧内容', '旧内容', ?, 'legacy')",
      [id, '700000000000000001', t]
    );
    expect(ingestMessage(ingestFixture({ messageId: id, createdAt: t, content: '旧内容', source: 'backfill' }))).toBe('updated');
    expect(getStoredMessage(id)).toMatchObject({ author_id: ALICE, guild_id: GUILD_ID, source: 'backfill' });
  });
});

describe('关掉被动观察（审查修复）', () => {
  test('只记叫到 bot 的消息和它的 AI 回复；其余消息、bot 的其它消息不记', () => {
    setupAiTest({ memory: { enabled: true, observe: { enabled: false } } });
    expect(skipReason(ingestFixture({ content: '大家好' }))).toBe('not-observed');
    expect(ingestMessage(ingestFixture({ content: '@memecat 你好', addressed: true }))).toBe('inserted');
    expect(ingestMessage(ingestFixture({ authorId: SELF_ID, username: 'memecat', kind: 'bot_ai', content: '你好呀' }), { forceKind: true })).toBe('inserted');
    expect(ingestMessage(ingestFixture({ authorId: SELF_ID, username: 'memecat', kind: 'bot_other', content: '推文转发' }), { forceKind: true })).toBe('skipped');
  });
});

describe('分类黑名单（审查修复）', () => {
  test('把分类加进黑名单：分类下频道里的子区也不观察（带分类信息，或从库里查父频道的父级）', () => {
    const CATEGORY = '700000000000000100';
    const PARENT = '700000000000000101';
    const THREAD = '700000000000000102';
    setupAiTest({ memory: { enabled: true, observe: { channelDenylist: [CATEGORY] } } });
    const thread = { channelId: THREAD, guildId: GUILD_ID, parentId: PARENT, name: '帖子', type: 'thread' };
    expect(skipReason(ingestFixture({ channel: { ...thread, categoryId: CATEGORY } }))).toBe('channel-denylisted');
    getDatabase().run("INSERT INTO channels (channel_id, guild_id, parent_id, name, type, updated_at) VALUES (?, ?, ?, '父频道', 'text', 1)", [PARENT, GUILD_ID, CATEGORY]);
    expect(skipReason(ingestFixture({ channel: thread }))).toBe('channel-denylisted');
  });
});

describe('关掉被动观察时的编辑（审查修复）', () => {
  test('已入库的直接对话被编辑了照样同步（比如删掉了里面的私人信息）', () => {
    setupAiTest({ memory: { enabled: true, observe: { enabled: false } } });
    const m = ingestFixture({ content: '@memecat 我的生日是 5 月 1 日', addressed: true });
    expect(ingestMessage(m)).toBe('inserted');
    const edited = ingestFixture({ messageId: m.messageId, content: '@memecat 你好', addressed: true });
    expect(ingestEdit(m.messageId, edited.contentRaw, edited.rendered, Date.now())).toBe(true);
    expect(getStoredMessage(m.messageId)?.content_text).toBe('@memecat 你好');
  });
});
