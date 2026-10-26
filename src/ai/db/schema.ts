import type { Database } from 'bun:sqlite';
import { forbiddenReason, looksSensitive } from '../memory/sensitive';
import { runMigrations, type Migration } from './migrate';

/**
 * AI 子系统的数据结构迁移。只能追加新版本，已发布的版本不要再改（改了也不会在老库上重跑）。
 */
export const AI_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'infrastructure',
    up: (db) => {
      db.run(`
        CREATE TABLE kv_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 50,
          dedupe_key TEXT,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          run_after INTEGER NOT NULL,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.run(`CREATE UNIQUE INDEX ux_jobs_dedupe ON jobs(dedupe_key) WHERE status IN ('pending','running')`);
      db.run('CREATE INDEX ix_jobs_ready ON jobs(status, priority DESC, run_after)');
      db.run(`
        CREATE TABLE llm_usage (
          day TEXT NOT NULL,
          purpose TEXT NOT NULL,
          model TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, purpose, model)
        )
      `);
    },
  },
  {
    version: 2,
    name: 'identity-and-messages',
    up: (db) => {
      db.run(`
        CREATE TABLE users (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          global_name TEXT,
          avatar_url TEXT,
          is_bot INTEGER NOT NULL DEFAULT 0,
          is_self INTEGER NOT NULL DEFAULT 0,
          account_created_at INTEGER NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          refreshed_at INTEGER,
          opted_out_at INTEGER
        )
      `);
      db.run(`
        CREATE TABLE guilds (
          guild_id TEXT PRIMARY KEY,
          name TEXT,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE guild_members (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          nickname TEXT,
          display_name TEXT NOT NULL,
          roles TEXT,
          joined_at INTEGER,
          premium_since INTEGER,
          left_at INTEGER,
          message_count INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          refreshed_at INTEGER,
          PRIMARY KEY (guild_id, user_id)
        )
      `);
      db.run('CREATE INDEX ix_guild_members_user ON guild_members(user_id)');
      db.run(`
        CREATE TABLE name_history (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL CHECK (kind IN ('username','global_name','nick')),
          value TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          UNIQUE (user_id, guild_id, kind, value)
        )
      `);
      db.run(`
        CREATE TABLE interaction_edges (
          guild_id TEXT NOT NULL,
          from_user_id TEXT NOT NULL,
          to_user_id TEXT NOT NULL,
          mentions INTEGER NOT NULL DEFAULT 0,
          replies INTEGER NOT NULL DEFAULT 0,
          reactions INTEGER NOT NULL DEFAULT 0,
          last_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, from_user_id, to_user_id)
        )
      `);
      db.run('CREATE INDEX ix_edges_to ON interaction_edges(to_user_id)');
      db.run(`
        CREATE TABLE activity_sessions (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          details TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL
        )
      `);
      db.run('CREATE INDEX ix_activity_user ON activity_sessions(user_id, started_at)');
      db.run(`
        CREATE TABLE user_stats (
          user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          stats TEXT NOT NULL,
          computed_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, guild_id)
        )
      `);
      db.run(`
        CREATE TABLE channels (
          channel_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          parent_id TEXT,
          name TEXT,
          type TEXT NOT NULL,
          readable INTEGER NOT NULL DEFAULT 1,
          newest_message_id TEXT,
          oldest_message_id TEXT,
          history_complete INTEGER NOT NULL DEFAULT 0,
          history_exhausted INTEGER NOT NULL DEFAULT 0,
          last_gapfill_at INTEGER,
          last_backfill_at INTEGER,
          proactive_bias REAL NOT NULL DEFAULT 0,
          last_bot_message_at INTEGER,
          quiet_until INTEGER,
          updated_at INTEGER NOT NULL
        )
      `);
      db.run('CREATE INDEX ix_channels_guild ON channels(guild_id)');
      db.run(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          message_id TEXT NOT NULL UNIQUE,
          guild_id TEXT NOT NULL DEFAULT '',
          channel_id TEXT NOT NULL,
          author_id TEXT,
          author_name TEXT NOT NULL,
          msg_kind TEXT NOT NULL DEFAULT 'user' CHECK (msg_kind IN ('user','bot_ai','bot_other')),
          proactive INTEGER NOT NULL DEFAULT 0,
          reply_to_id TEXT,
          content_raw TEXT NOT NULL,
          content_text TEXT NOT NULL,
          mentions TEXT,
          attachments TEXT,
          attachments_at INTEGER,
          created_at INTEGER NOT NULL,
          edited_at INTEGER,
          extracted_at INTEGER,
          source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','backfill','legacy'))
        )
      `);
      db.run('CREATE INDEX ix_messages_channel_time ON messages(channel_id, created_at)');
      db.run('CREATE INDEX ix_messages_guild_time ON messages(guild_id, created_at)');
      db.run('CREATE INDEX ix_messages_author_time ON messages(author_id, created_at)');
      db.run('CREATE INDEX ix_messages_pending ON messages(channel_id, created_at) WHERE extracted_at IS NULL');
      db.run(
        "CREATE VIRTUAL TABLE messages_fts USING fts5(content_text, content='messages', content_rowid='id', tokenize='trigram')"
      );
      db.run(`
        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
        END
      `);
      db.run(`
        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
        END
      `);
      db.run(`
        CREATE TRIGGER messages_fts_au AFTER UPDATE OF content_text ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
          INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
        END
      `);

      importLegacyChannelMessages(db);
      importLegacyConversations(db, Number.MAX_SAFE_INTEGER);
    },
  },
  {
    version: 3,
    name: 'memories',
    up: (db) => {
      db.run(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('user','guild','self','relation')),
          subject_id TEXT NOT NULL,
          object_id TEXT,
          guild_id TEXT,
          kind TEXT NOT NULL,
          slot TEXT,
          value TEXT,
          content TEXT NOT NULL,
          importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
          confidence REAL NOT NULL DEFAULT 0.8,
          pinned INTEGER NOT NULL DEFAULT 0,
          sensitive INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
          superseded_by INTEGER,
          origin TEXT NOT NULL CHECK (origin IN ('extractor','appraisal','reflection','tool','user','legacy')),
          source_user_id TEXT,
          evidence TEXT,
          images TEXT,
          event_at INTEGER,
          valid_until INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_accessed_at INTEGER,
          access_count INTEGER NOT NULL DEFAULT 0,
          embed_model TEXT
        )
      `);
      db.run(
        "CREATE UNIQUE INDEX ux_memories_slot ON memories(scope, subject_id, slot) WHERE slot IS NOT NULL AND status = 'active'"
      );
      db.run('CREATE INDEX ix_memories_subject ON memories(scope, subject_id, status, pinned, importance DESC)');
      db.run('CREATE INDEX ix_memories_object ON memories(object_id) WHERE object_id IS NOT NULL');
      db.run('CREATE INDEX ix_memories_upcoming ON memories(scope, subject_id, event_at) WHERE event_at IS NOT NULL');
      db.run('CREATE INDEX ix_memories_embed ON memories(status, embed_model)');
      db.run("CREATE INDEX ix_memories_value ON memories(value) WHERE value IS NOT NULL AND status = 'active'");
      db.run(
        "CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='trigram')"
      );
      db.run(`
        CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.run(`
        CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END
      `);
      db.run(`
        CREATE TRIGGER memories_fts_au AFTER UPDATE OF content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.run(`
        CREATE TABLE profiles (
          scope TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          memory_watermark INTEGER NOT NULL,
          model TEXT,
          generated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, subject_id)
        )
      `);

      importLegacyMemories(db);
      // v2 之后旧版仍在写 ai_conversations（实时消息已直接入库）；只补 v2 执行前的那部分，避免重复
      const v2 = db.query('SELECT applied_at FROM schema_migrations WHERE version = 2').get() as { applied_at: number } | null;
      importLegacyConversations(db, v2?.applied_at ?? Number.MAX_SAFE_INTEGER);
      for (const t of ['ai_memories', 'ai_conversations', 'channel_messages']) {
        if (tableExists(db, t) && !tableExists(db, `_legacy_${t}`)) db.run(`ALTER TABLE "${t}" RENAME TO "_legacy_${t}"`);
      }
    },
  },
  {
    version: 4,
    name: 'affinity-and-mood',
    up: (db) => {
      db.run(`
        CREATE TABLE relationships (
          user_id TEXT PRIMARY KEY,
          affinity INTEGER NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -100 AND 100),
          impression TEXT,
          pet_name TEXT,
          interactions INTEGER NOT NULL DEFAULT 0,
          first_interaction_at INTEGER,
          last_interaction_at INTEGER,
          updated_at INTEGER NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE affinity_events (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          guild_id TEXT,
          message_id TEXT,
          delta INTEGER NOT NULL,
          before INTEGER NOT NULL,
          after INTEGER NOT NULL,
          category TEXT,
          reason TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('appraisal','observed','decay','admin')),
          created_at INTEGER NOT NULL
        )
      `);
      db.run('CREATE INDEX ix_affinity_events_user ON affinity_events(user_id, created_at)');
      db.run(`
        CREATE TABLE mood_state (
          soul_id TEXT PRIMARY KEY DEFAULT 'default',
          valence REAL NOT NULL,
          arousal REAL NOT NULL,
          cause TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE mood_events (
          id INTEGER PRIMARY KEY,
          dv REAL NOT NULL,
          da REAL NOT NULL,
          cause TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('interaction','atmosphere','proactive','observed','admin')),
          user_id TEXT,
          guild_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      db.run('CREATE INDEX ix_mood_events_user ON mood_events(user_id, created_at)');
      db.run('CREATE INDEX ix_mood_events_time ON mood_events(created_at)');
    },
  },
  {
    version: 5,
    name: 'vectors',
    up: (db) => {
      // 唯一数据源：归一化后的 float32 向量。sqlite-vec 可用时另建 vec_bin_<dims> 二值索引（派生，可随时重建）
      db.run(`
        CREATE TABLE vectors (
          id INTEGER PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id INTEGER NOT NULL,
          scope_key TEXT NOT NULL,
          part TEXT NOT NULL,
          model TEXT NOT NULL,
          dims INTEGER NOT NULL,
          vector BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (owner_type, owner_id)
        )
      `);
      db.run('CREATE INDEX ix_vectors_scope ON vectors(model, scope_key)');
      db.run('CREATE INDEX ix_vectors_part ON vectors(model, part)');
    },
  },
  {
    version: 6,
    name: 'forget-tombstones',
    up: (db) => {
      // /forget-me 的删除墓碑：只存加盐哈希，用来阻止历史回望把删除前的消息再导入回来
      db.run(`
        CREATE TABLE forgotten_users (
          id_hash TEXT PRIMARY KEY,
          forgotten_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    version: 7,
    name: 'forget-message-tombstones',
    up: (db) => {
      // /forget-me 连带删掉的 bot 消息（直接发到频道的插话没有回复引用，回望时认不出是冲谁说的）：记下消息 ID，不再导回来
      db.run(`
        CREATE TABLE forgotten_messages (
          message_id TEXT PRIMARY KEY,
          forgotten_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    version: 8,
    name: 'legacy-memory-privacy',
    up: (db) => {
      // 旧版本的键值记忆导入时没有做隐私检查：含禁止保存的信息（手机号、证件号……）的删除，
      // 涉及敏感话题或敏感属性（性别、感情状况）的标为敏感（只在和本人聊天时使用）。来源无法确认，一律保守处理
      const rows = db.query("SELECT id, subject_id, slot, value, content FROM memories WHERE origin = 'legacy'").all() as Array<{
        id: number;
        subject_id: string;
        slot: string | null;
        value: string | null;
        content: string;
      }>;
      const now = Date.now();
      const touched = new Set<string>();
      for (const r of rows) {
        const text = `${r.content} ${r.value ?? ''}`;
        if (forbiddenReason(text)) {
          db.run('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?', [r.id]);
          db.run('DELETE FROM memories WHERE id = ?', [r.id]);
          db.run("DELETE FROM vectors WHERE owner_type = 'memory' AND owner_id = ?", [r.id]);
          touched.add(r.subject_id);
        } else if (looksSensitive(text) || r.slot === 'gender' || r.slot === 'relationship_status') {
          db.run('UPDATE memories SET sensitive = 1, updated_at = ? WHERE id = ?', [now, r.id]);
          touched.add(r.subject_id);
        }
      }
      // 已经从这些记忆写出来的画像和反思特点可能带着这些内容（别人也看得到）：失效，之后按处理后的记忆重新生成
      for (const subject of touched) {
        db.run("DELETE FROM profiles WHERE scope = 'user' AND subject_id = ?", [subject]);
        db.run("DELETE FROM memories WHERE scope = 'user' AND subject_id = ? AND origin = 'reflection' AND pinned = 0", [subject]);
      }
    },
  },
  {
    version: 9,
    name: 'message-reply-author',
    up: (db) => {
      // bot 的消息记下它回复的是谁：被回复的原消息先被删掉（成员自己删、或过了保留期）时，
      // /forget-me 仍然能找到 bot 对 TA 说过的话
      db.run('ALTER TABLE messages ADD COLUMN reply_to_author_id TEXT');
      db.run('CREATE INDEX ix_messages_reply_author ON messages(reply_to_author_id) WHERE reply_to_author_id IS NOT NULL');
    },
  },
  {
    version: 10,
    name: 'memory-participants',
    up: (db) => {
      // 服务器记忆、窗口摘要是从哪些成员的发言来的（用户 ID 的 JSON 数组）：原消息被删掉 / 过了保留期，
      // /forget-me 仍然认得出"这条有 TA 的份"
      db.run('ALTER TABLE memories ADD COLUMN participants TEXT');
    },
  },
];

/** 单值属性的白名单：同一主体同一 slot 只有一条有效记忆，新值会取代旧值（旧值保留为历史） */
export const SLOT_WHITELIST: readonly string[] = [
  'preferred_name',
  'gender',
  'birthday',
  'age_range',
  'location',
  'timezone',
  'occupation',
  'school',
  'languages',
  'pets',
  'relationship_status',
];

/** 旧的 KV 记忆（ai_memories：按用户名、key/value/weight）→ memories。白名单内的 key 作为 slot，其余作为普通事实。 */
function importLegacyMemories(db: Database): void {
  if (!tableExists(db, 'ai_memories')) return;
  const rows = db
    .query(
      "SELECT username, key, value, weight, created_at, updated_at, access_count, last_accessed_at FROM ai_memories WHERE platform = 'discord' ORDER BY id"
    )
    .all() as Array<{
    username: string;
    key: string;
    value: string;
    weight: number;
    created_at: number;
    updated_at: number;
    access_count: number;
    last_accessed_at: number | null;
  }>;
  const insert = db.prepare(
    `INSERT INTO memories (scope, subject_id, guild_id, kind, slot, value, content, importance, confidence, origin,
                           source_user_id, created_at, updated_at, last_accessed_at, access_count)
     VALUES ('user', ?, NULL, 'fact', ?, ?, ?, ?, 0.8, 'legacy', ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    const slot = SLOT_WHITELIST.includes(r.key) ? r.key : null;
    const importance = Math.max(1, Math.min(10, Math.round((Number(r.weight) || 0.5) * 10)));
    const subject = `legacy:${r.username}`;
    const value = slot ? slotValueFromContent(r.value) : null;
    insert.run(subject, slot, value, r.value, importance, subject, r.created_at, r.updated_at, r.last_accessed_at, r.access_count ?? 0);
  }
}

/** 从"希望被称呼为「翅膀」"这类陈述里取出简短取值：优先引号里的内容，否则整句足够短时用整句 */
export function slotValueFromContent(content: string): string | null {
  const m = String(content || '').match(/[「『“"‘'《]([^」』”"’'》]{1,30})[」』”"’'》]/);
  if (m) return m[1].trim() || null;
  const t = String(content || '').trim();
  return t && [...t].length <= 12 ? t : null;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name));
}

/** 旧的频道消息日志（只有显示名、没有 guild/user ID）→ messages。guild_id 留空，由运行时按频道补上；
 *  作者 ID 留空，历史回望重新拉到同一条消息时会补全。 */
function importLegacyChannelMessages(db: Database): void {
  if (!tableExists(db, 'channel_messages')) return;
  const cols = columnNames(db, 'channel_messages');
  const attachmentsExpr = cols.has('images')
    ? `CASE WHEN images IS NULL OR images = '' THEN NULL ELSE (
         SELECT json_group_array(json_object('url', value, 'type', 'image', 'name', '')) FROM json_each(images)
       ) END`
    : 'NULL';
  const attachmentsAtExpr = cols.has('images_at') ? 'images_at' : 'NULL';
  db.run(`
    INSERT OR IGNORE INTO messages
      (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text,
       attachments, attachments_at, created_at, source)
    SELECT COALESCE(message_id, 'legacy-cm-' || id), '', channel_id, NULL, author, 'user', content, content,
           ${attachmentsExpr}, ${attachmentsAtExpr}, created_at, 'legacy'
    FROM channel_messages
    WHERE platform = 'discord'
    ORDER BY created_at, id
  `);
}

/** 旧的一对一 AI 对话日志 → messages（每个用户一个虚拟频道 legacy-dm:<username>）。
 *  只导入 created_at < before 的行：新版本上线后实时消息已经直接入库，避免重复。 */
export function importLegacyConversations(db: Database, before: number): void {
  if (!tableExists(db, 'ai_conversations')) return;
  db.run(
    `
    INSERT OR IGNORE INTO messages
      (message_id, guild_id, channel_id, author_id, author_name, msg_kind, content_raw, content_text, created_at, source)
    SELECT 'legacy-conv-' || id, '', 'legacy-dm:' || username,
           CASE WHEN role = 'user' THEN 'legacy:' || username ELSE NULL END,
           CASE WHEN role = 'user' THEN username ELSE 'bot' END,
           CASE WHEN role = 'user' THEN 'user' ELSE 'bot_ai' END,
           content, content, created_at, 'legacy'
    FROM ai_conversations
    WHERE platform = 'discord' AND created_at < ?
    ORDER BY created_at, id
  `,
    [before]
  );
}

let schemaReady = false;

/** 执行 AI 迁移。失败时只记录错误并把 AI 数据层标记为不可用，不向上抛，保证推文转发等核心功能照常启动。 */
export function migrateAiSchema(db: Database, opts: { quiet?: boolean } = {}): boolean {
  try {
    const res = runMigrations(db, AI_MIGRATIONS);
    if (res.applied.length > 0 && !opts.quiet) {
      console.log(`[DB] AI 数据结构已迁移到 v${res.current}（本次执行: ${res.applied.join(', ')}）`);
    }
    schemaReady = true;
  } catch (e) {
    schemaReady = false;
    console.error('[DB] AI 数据迁移失败，记忆相关功能将不可用:', (e as Error).message);
  }
  return schemaReady;
}

/** AI 数据层是否可用（迁移成功）。记忆/好感/情绪等模块在读写前应先检查。 */
export function isAiSchemaReady(): boolean {
  return schemaReady;
}
