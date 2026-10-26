import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations, type Migration } from './migrate';
import { AI_MIGRATIONS, slotValueFromContent } from './schema';

function tableNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}

describe('runMigrations', () => {
  test('按版本顺序执行，并且重复执行是幂等的', () => {
    const db = new Database(':memory:');
    const order: number[] = [];
    const migrations: Migration[] = [
      { version: 2, name: 'b', up: (d) => { order.push(2); d.run('CREATE TABLE b (x)'); } },
      { version: 1, name: 'a', up: (d) => { order.push(1); d.run('CREATE TABLE a (x)'); } },
    ];

    expect(runMigrations(db, migrations)).toEqual({ applied: [1, 2], current: 2 });
    expect(order).toEqual([1, 2]);
    expect(runMigrations(db, migrations)).toEqual({ applied: [], current: 2 });
    expect(order).toEqual([1, 2]);
  });

  test('只执行新增的版本', () => {
    const db = new Database(':memory:');
    const v1: Migration = { version: 1, name: 'a', up: (d) => d.run('CREATE TABLE a (x)') };
    runMigrations(db, [v1]);
    const res = runMigrations(db, [v1, { version: 2, name: 'b', up: (d) => d.run('CREATE TABLE b (x)') }]);
    expect(res).toEqual({ applied: [2], current: 2 });
    expect(tableNames(db)).toContain('b');
  });

  test('失败的版本整体回滚、不记录，后续版本不执行', () => {
    const db = new Database(':memory:');
    const migrations: Migration[] = [
      { version: 1, name: 'ok', up: (d) => d.run('CREATE TABLE ok (x)') },
      {
        version: 2,
        name: 'boom',
        up: (d) => {
          d.run('CREATE TABLE half (x)');
          throw new Error('boom');
        },
      },
      { version: 3, name: 'after', up: (d) => d.run('CREATE TABLE after_boom (x)') },
    ];

    expect(() => runMigrations(db, migrations)).toThrow('boom');
    const names = tableNames(db);
    expect(names).toContain('ok');
    expect(names).not.toContain('half');
    expect(names).not.toContain('after_boom');
    const versions = (db.query('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([1]);
  });

  test('拒绝重复或非法的版本号', () => {
    const db = new Database(':memory:');
    const noop = () => {};
    expect(() => runMigrations(db, [{ version: 1, name: 'a', up: noop }, { version: 1, name: 'b', up: noop }])).toThrow('重复');
    expect(() => runMigrations(db, [{ version: 0, name: 'z', up: noop }])).toThrow('正整数');
  });

  test('数据库版本高于程序已知版本时不报错', () => {
    const db = new Database(':memory:');
    runMigrations(db, [{ version: 5, name: 'future', up: () => {} }]);
    expect(runMigrations(db, [{ version: 1, name: 'a', up: () => {} }]).current).toBe(5);
  });
});

describe('AI_MIGRATIONS 旧数据导入', () => {
  test('channel_messages 与 ai_conversations 导入 messages，图片 JSON 转成附件格式', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE channel_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'discord',
      channel_id TEXT NOT NULL, message_id TEXT, author TEXT NOT NULL, content TEXT NOT NULL, images TEXT, images_at INTEGER, created_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO channel_messages (channel_id, message_id, author, content, images, images_at, created_at)
      VALUES ('c1', '111111111111111111', '小A', '看图', '["https://cdn.example/a.png"]', 5, 10),
             ('c1', NULL, '小B', '无 ID 的旧消息', NULL, NULL, 11)`);
    db.run(`CREATE TABLE ai_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'discord',
      username TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO ai_conversations (username, role, content, created_at) VALUES ('alice', 'user', '我叫阿丽', 20), ('alice', 'assistant', '你好阿丽', 21)`);

    runMigrations(db, AI_MIGRATIONS);
    const rows = db
      .query('SELECT message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_text, attachments, source FROM messages ORDER BY created_at')
      .all();
    expect(rows).toEqual([
      { message_id: '111111111111111111', guild_id: '', channel_id: 'c1', author_id: null, author_name: '小A', msg_kind: 'user', content_text: '看图', attachments: '[{"url":"https://cdn.example/a.png","type":"image","name":""}]', source: 'legacy' },
      { message_id: expect.stringMatching(/^legacy-cm-/), guild_id: '', channel_id: 'c1', author_id: null, author_name: '小B', msg_kind: 'user', content_text: '无 ID 的旧消息', attachments: null, source: 'legacy' },
      { message_id: expect.stringMatching(/^legacy-conv-/), guild_id: '', channel_id: 'legacy-dm:alice', author_id: 'legacy:alice', author_name: 'alice', msg_kind: 'user', content_text: '我叫阿丽', attachments: null, source: 'legacy' },
      { message_id: expect.stringMatching(/^legacy-conv-/), guild_id: '', channel_id: 'legacy-dm:alice', author_id: null, author_name: 'bot', msg_kind: 'bot_ai', content_text: '你好阿丽', attachments: null, source: 'legacy' },
    ]);
    // 全文索引同步建立
    expect(db.query("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH '我叫阿'").get()).toEqual({ c: 1 });
  });
});

describe('AI_MIGRATIONS v3', () => {
  test('旧 KV 记忆导入（白名单 key 变成 slot）、旧表改名、v2 之后写入的旧对话不重复导入', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE ai_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'discord', username TEXT NOT NULL,
      key TEXT NOT NULL, value TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER, UNIQUE(platform, username, key))`);
    db.run(`INSERT INTO ai_memories (username, key, value, weight, created_at, updated_at) VALUES
      ('alice', 'occupation', '是一名后端工程师', 0.8, 1, 2), ('alice', 'likes', '喜欢猫', 0.3, 1, 2)`);
    db.run(`CREATE TABLE ai_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'discord',
      username TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO ai_conversations (username, role, content, created_at) VALUES ('alice', 'user', '旧对话', 5)`);

    runMigrations(db, AI_MIGRATIONS.filter((m) => m.version <= 2));
    // v2 之后旧版本还在写 ai_conversations（实时消息已经直接入库了）
    db.run(`INSERT INTO ai_conversations (username, role, content, created_at) VALUES ('alice', 'user', 'v2 之后的对话', ?)`, [Date.now() + 60_000]);
    runMigrations(db, AI_MIGRATIONS);

    const mems = db.query('SELECT subject_id, kind, slot, content, importance, origin FROM memories ORDER BY id').all();
    expect(mems).toEqual([
      { subject_id: 'legacy:alice', kind: 'fact', slot: 'occupation', content: '是一名后端工程师', importance: 8, origin: 'legacy' },
      { subject_id: 'legacy:alice', kind: 'fact', slot: null, content: '喜欢猫', importance: 3, origin: 'legacy' },
    ]);
    const convs = (db.query("SELECT content_text FROM messages WHERE channel_id = 'legacy-dm:alice'").all() as Array<{ content_text: string }>).map((r) => r.content_text);
    expect(convs).toEqual(['旧对话']);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['_legacy_ai_memories', '_legacy_ai_conversations']));
    expect(tableNames(db)).not.toContain('ai_memories');
  });
});

describe('AI_MIGRATIONS v8', () => {
  test('旧版本导入的记忆补做隐私处理：含手机号的删除，涉及敏感话题 / 敏感属性的标为敏感', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE ai_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'discord', username TEXT NOT NULL,
      key TEXT NOT NULL, value TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER, UNIQUE(platform, username, key))`);
    db.run(`INSERT INTO ai_memories (username, key, value, weight, created_at, updated_at) VALUES
      ('alice', 'phone', '手机号 13812345678', 0.5, 1, 2), ('alice', 'health', '确诊了抑郁症', 0.5, 1, 2),
      ('alice', 'relationship_status', '已婚', 0.5, 1, 2), ('alice', 'likes', '喜欢猫', 0.5, 1, 2)`);
    runMigrations(db, AI_MIGRATIONS.filter((m) => m.version <= 7));
    // 已经从旧记忆写出来的画像
    db.run("INSERT INTO profiles (scope, subject_id, summary, memory_watermark, model, generated_at) VALUES ('user', 'legacy:alice', 'alice 已婚，有抑郁症', 0, 'm', 1)");
    db.run("DELETE FROM schema_migrations WHERE version = 8");
    runMigrations(db, AI_MIGRATIONS);
    expect(db.query("SELECT COUNT(*) AS c FROM profiles WHERE subject_id = 'legacy:alice'").get()).toEqual({ c: 0 });
    expect(db.query('SELECT content, sensitive FROM memories ORDER BY id').all()).toEqual([
      { content: '确诊了抑郁症', sensitive: 1 },
      { content: '已婚', sensitive: 1 },
      { content: '喜欢猫', sensitive: 0 },
    ]);
  });
});

describe('slotValueFromContent', () => {
  test('取引号里的内容；整句很短时用整句', () => {
    expect(slotValueFromContent('希望被称呼为“翅膀”')).toBe('翅膀');
    expect(slotValueFromContent('希望被称呼为「阿伟」')).toBe('阿伟');
    expect(slotValueFromContent('杭州')).toBe('杭州');
    expect(slotValueFromContent('在杭州一家互联网公司做前端开发，平时很忙')).toBeNull();
  });
});

describe('AI_MIGRATIONS', () => {
  test('能在空库上完整执行，且 FTS5 trigram 可用', () => {
    const db = new Database(':memory:');
    const res = runMigrations(db, AI_MIGRATIONS);
    expect(res.current).toBe(AI_MIGRATIONS[AI_MIGRATIONS.length - 1].version);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['kv_meta', 'jobs', 'llm_usage']));
    // 后续阶段的表依赖 trigram 分词器做中文检索，这里先确认运行时支持
    db.run("CREATE VIRTUAL TABLE t USING fts5(c, tokenize='trigram')");
  });
});
