import { beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '../storage';
import { ingestMessage, skipReason } from './ingest';
import { addMemory, listMemories } from './memory/store';
import { runRetention } from './retention';
import { ingestFixture, setupAiTest } from '../testing/fixtures';

const A = '100000000000000001';
const DAY = 86400_000;

function seed(now: number): void {
  ingestMessage(ingestFixture({ authorId: A, createdAt: now - 20 * DAY, content: '很久以前说的话' }));
  ingestMessage(ingestFixture({ authorId: A, createdAt: now - 10 * DAY, content: '十天前说的话' }));
  ingestMessage(ingestFixture({ authorId: A, createdAt: now - DAY, content: '昨天说的话' }));
  addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '很久以前提炼的记忆', origin: 'extractor' });
  getDatabase().run("INSERT INTO activity_sessions (user_id, type, name, started_at, ended_at) VALUES (?, 'playing', 'x', ?, ?), (?, 'playing', 'y', ?, ?)", [
    A,
    now - 30 * DAY,
    now - 29 * DAY,
    A,
    now - 2 * DAY,
    now - DAY,
  ]);
}

const count = (sql: string): number => (getDatabase().query(sql).get() as { c: number }).c;

describe('保留期', () => {
  test('retentionDays = 0：永久保留，什么都不删', () => {
    setupAiTest();
    const now = Date.now();
    seed(now);
    expect(runRetention(now)).toEqual({ messages: 0, sessions: 0 });
    expect(count('SELECT COUNT(*) AS c FROM messages')).toBe(3);
  });

  describe('retentionDays = 7', () => {
    beforeEach(() => setupAiTest({ memory: { enabled: true, observe: { retentionDays: 7 } } }));

    test('删除超过保留期的消息与在线活动；记忆不受影响；全文索引同步', () => {
      // 入库时会跳过过期消息，这里直接写库造数据
      const now = Date.now();
      const db = getDatabase();
      for (const [i, days] of [20, 10, 1].entries()) {
        db.run(
          "INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text, created_at, source) VALUES (?, 'g', 'c', ?, 'a', 'user', ?, ?, ?, 'live')",
          [`m${i}`, A, `第${i}条消息内容`, `第${i}条消息内容`, now - days * DAY]
        );
      }
      addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '很久以前提炼的记忆', origin: 'extractor' });
      db.run("INSERT INTO activity_sessions (user_id, type, name, started_at, ended_at) VALUES (?, 'playing', 'x', ?, ?), (?, 'playing', 'y', ?, ?)", [
        A,
        now - 30 * DAY,
        now - 29 * DAY,
        A,
        now - 2 * DAY,
        now - DAY,
      ]);

      expect(runRetention(now)).toEqual({ messages: 2, sessions: 1 });
      expect((db.query('SELECT message_id FROM messages').all() as Array<{ message_id: string }>).map((r) => r.message_id)).toEqual(['m2']);
      expect(db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '第0条'").all()).toEqual([]);
      expect(db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '第2条'").all()).toHaveLength(1);
      expect(listMemories({ scope: 'user', subjectId: A, includeSensitive: true, limit: 10 })).toHaveLength(1);
      expect(runRetention(now)).toEqual({ messages: 0, sessions: 0 });
    });

    test('升级前保留下来的旧消息表同样按保留期清理', () => {
      const now = Date.now();
      const db = getDatabase();
      db.run('CREATE TABLE _legacy_channel_messages (id INTEGER PRIMARY KEY, author TEXT, content TEXT, created_at INTEGER)');
      db.run('CREATE TABLE _legacy_ai_conversations (id INTEGER PRIMARY KEY, username TEXT, content TEXT, created_at INTEGER)');
      db.run("INSERT INTO _legacy_channel_messages (author, content, created_at) VALUES ('a', '旧', ?), ('a', '新', ?)", [now - 30 * DAY, now - DAY]);
      db.run("INSERT INTO _legacy_ai_conversations (username, content, created_at) VALUES ('a', '旧', ?)", [now - 30 * DAY]);
      expect(runRetention(now).messages).toBe(2);
      expect(count('SELECT COUNT(*) AS c FROM _legacy_channel_messages')).toBe(1);
      expect(count('SELECT COUNT(*) AS c FROM _legacy_ai_conversations')).toBe(0);
    });

    test('历史回望拉到的过期消息不入库', () => {
      const now = Date.now();
      const old = ingestFixture({ authorId: A, createdAt: now - 10 * DAY, content: '十天前', source: 'backfill' });
      expect(skipReason(old)).toBe('expired');
      expect(ingestMessage(old)).toBe('skipped');
      expect(ingestMessage(ingestFixture({ authorId: A, createdAt: now - DAY, content: '昨天' }))).toBe('inserted');
    });
  });
});
