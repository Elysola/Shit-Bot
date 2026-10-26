import { Database } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import { migrateAiSchema } from './ai/db/schema';

function resolveDataDir(): string {
  const cwd = path.join(process.cwd(), 'data');
  if (fs.existsSync(cwd)) return cwd;
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, 'bot.db');

/** data 目录（bot.db 所在处）。人设卡、lorebook 等相对路径以它的上一级（项目根）为基准解析。 */
export function getDataDir(): string {
  return DATA_DIR;
}

/** 把配置里的相对路径（如 data/personas）解析成绝对路径；绝对路径原样返回 */
export function resolveProjectPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(path.dirname(DATA_DIR), p);
}

let db: Database | null = null;
// 每次 initDatabase 自增；各模块的内存缓存据此判断数据库是否已被替换（测试换内存库时尤其需要）
let dbGeneration = 0;

export function getDatabaseGeneration(): number {
  return dbGeneration;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** 打开数据库并建表/迁移。dbPath 传 ':memory:' 可得到一个独立的内存库（测试用）；重复调用会先关闭旧连接。 */
export function initDatabase(dbPath: string = DB_PATH): void {
  const inMemory = dbPath === ':memory:';
  if (!inMemory) ensureDataDir();

  if (db) {
    db.close();
    db = null;
  }
  db = new Database(dbPath);
  dbGeneration++;

  db.run('PRAGMA journal_mode = WAL');

  db.run(`
    CREATE TABLE IF NOT EXISTS sent_tweets (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      content TEXT,
      url TEXT,
      sent_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS image_cache (
      tweet_id TEXT PRIMARY KEY,
      image_data BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tweet_id TEXT,
      sent_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sent_tg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      tweet_id TEXT,
      sent_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_sent_tweets_author ON sent_tweets(author)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sent_tweets_sent_at ON sent_tweets(sent_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sent_messages_channel ON sent_messages(channel_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sent_messages_tweet_id ON sent_messages(tweet_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sent_tg_messages_chat ON sent_tg_messages(chat_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sent_tg_messages_tweet_id ON sent_tg_messages(tweet_id)');

  db.run(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      approval_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      tweet_id TEXT NOT NULL DEFAULT '',
      tweet_json TEXT NOT NULL,
      telegram_msg_ids TEXT NOT NULL DEFAULT '{}',
      discord_msg_ids TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,
      sent_to TEXT,
      has_image INTEGER NOT NULL DEFAULT 0
    )
  `);

  try {
    db.run('ALTER TABLE pending_approvals ADD COLUMN tweet_id TEXT NOT NULL DEFAULT \'\'');
  } catch {
    // column already exists
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT NOT NULL,
      target_label TEXT NOT NULL,
      target_id TEXT NOT NULL,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_dead_letters_tweet_id ON dead_letters(tweet_id)');

  // AI 相关表走版本化迁移；失败只会让记忆类功能不可用，不影响推文转发等核心功能
  migrateAiSchema(db, { quiet: inMemory });

  if (!inMemory) console.log(`数据库已初始化: ${dbPath}`);
}

export function getDatabase(): Database {
  if (!db) {
    initDatabase();
  }
  return db!;
}

export function markAsSent(tweetId: string, author?: string, content?: string, url?: string): void {
  const database = getDatabase();
  database.run(
    `INSERT OR IGNORE INTO sent_tweets (id, author, content, url, sent_at) VALUES (?, ?, ?, ?, ?)`,
    [tweetId, author || '', content || '', url || '', Date.now()]
  );
}

export function isAlreadySent(tweetId: string): boolean {
  const database = getDatabase();
  const row = database.query('SELECT 1 FROM sent_tweets WHERE id = ?').get(tweetId);
  return !!row;
}

export function markMultipleAsSent(tweets: Array<{ id: string; author: string; content: string; url: string }>): void {
  const database = getDatabase();

  const insert = database.transaction((items: typeof tweets) => {
    for (const tweet of items) {
      database.run(
        `INSERT OR IGNORE INTO sent_tweets (id, author, content, url, sent_at) VALUES (?, ?, ?, ?, ?)`,
        [tweet.id, tweet.author, tweet.content, tweet.url, Date.now()]
      );
    }
  });

  insert(tweets);
}

export function isTooOld(publishedAt: Date, maxAgeMinutes: number): boolean {
  const now = Date.now();
  const tweetTime = publishedAt.getTime();
  const ageMinutes = (now - tweetTime) / (1000 * 60);
  return ageMinutes > maxAgeMinutes;
}

export function cleanupOldRecords(maxAgeDays: number = 30): number {
  const database = getDatabase();
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const result = database.run('DELETE FROM sent_tweets WHERE sent_at < ?', [cutoff]);

  if (result.changes > 0) {
    console.log(`已清理 ${result.changes} 条旧记录`);
  }

  return result.changes;
}

export function getSentCount(): number {
  const database = getDatabase();
  const row = database.query('SELECT COUNT(*) as count FROM sent_tweets').get() as { count: number };
  return row.count;
}

export function getRecentTweets(limit: number = 10): Array<{
  id: string;
  author: string;
  content: string;
  url: string;
  sent_at: number;
}> {
  const database = getDatabase();
  return database.query('SELECT * FROM sent_tweets ORDER BY sent_at DESC LIMIT ?').all(limit) as any[];
}

export function cacheImage(tweetId: string, imageBuffer: Buffer): void {
  const database = getDatabase();
  database.run(
    `INSERT OR REPLACE INTO image_cache (tweet_id, image_data, created_at) VALUES (?, ?, ?)`,
    [tweetId, imageBuffer, Date.now()]
  );
}

export function getCachedImage(tweetId: string): Buffer | null {
  const database = getDatabase();
  const row = database.query('SELECT image_data FROM image_cache WHERE tweet_id = ?').get(tweetId) as { image_data: Buffer } | undefined;
  return row ? row.image_data : null;
}

export function cleanupExpiredImages(maxAgeMinutes: number = 60): number {
  const database = getDatabase();
  const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
  const result = database.run('DELETE FROM image_cache WHERE created_at < ?', [cutoff]);

  if (result.changes > 0) {
    console.log(`已清理 ${result.changes} 条过期缓存图片`);
  }

  return result.changes;
}

export function storeSentMessage(channelId: string, messageId: string, tweetId?: string): void {
  const database = getDatabase();
  database.run(
    `INSERT INTO sent_messages (channel_id, message_id, tweet_id, sent_at) VALUES (?, ?, ?, ?)`,
    [channelId, messageId, tweetId || null, Date.now()]
  );
}

export function getRecentSentMessages(channelId: string, limit: number): Array<{
  id: number;
  channel_id: string;
  message_id: string;
  tweet_id: string | null;
  sent_at: number;
}> {
  const database = getDatabase();
  return database.query(
    'SELECT * FROM sent_messages WHERE channel_id = ? ORDER BY sent_at DESC LIMIT ?'
  ).all(channelId, limit) as any[];
}

export function deleteSentMessage(messageId: string): void {
  const database = getDatabase();
  database.run('DELETE FROM sent_messages WHERE message_id = ?', [messageId]);
}

export function cleanupOldSentMessages(maxAgeDays: number = 7): number {
  const database = getDatabase();
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const result = database.run('DELETE FROM sent_messages WHERE sent_at < ?', [cutoff]);
  return result.changes;
}

export function storeSentTgMessage(chatId: string, messageId: number, tweetId?: string): void {
  const database = getDatabase();
  database.run(
    `INSERT INTO sent_tg_messages (chat_id, message_id, tweet_id, sent_at) VALUES (?, ?, ?, ?)`,
    [chatId, messageId, tweetId || null, Date.now()]
  );
}

export function getSentTgMessagesByTweetId(tweetId: string): Array<{
  id: number;
  chat_id: string;
  message_id: number;
  tweet_id: string | null;
  sent_at: number;
}> {
  const database = getDatabase();
  return database.query(
    'SELECT * FROM sent_tg_messages WHERE tweet_id = ?'
  ).all(tweetId) as any[];
}

export function getSentDiscordMessagesByTweetId(tweetId: string): Array<{
  id: number;
  channel_id: string;
  message_id: string;
  tweet_id: string | null;
  sent_at: number;
}> {
  const database = getDatabase();
  return database.query(
    'SELECT * FROM sent_messages WHERE tweet_id = ?'
  ).all(tweetId) as any[];
}

export function getSentMessageByMessageId(messageId: string): { channel_id: string; message_id: string } | null {
  const database = getDatabase();
  return database.query(
    'SELECT channel_id, message_id FROM sent_messages WHERE message_id = ?'
  ).get(messageId) as { channel_id: string; message_id: string } | null;
}

export function deleteSentTgMessage(messageId: number, chatId: string): void {
  const database = getDatabase();
  database.run('DELETE FROM sent_tg_messages WHERE message_id = ? AND chat_id = ?', [messageId, chatId]);
}

export function cleanupOldSentTgMessages(maxAgeDays: number = 7): number {
  const database = getDatabase();
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const result = database.run('DELETE FROM sent_tg_messages WHERE sent_at < ?', [cutoff]);
  return result.changes;
}

export interface PersistedApproval {
  approvalId: string;
  groupName: string;
  tweetJson: string;
  telegramMsgIds: string;
  discordMsgIds: string;
  createdAt: number;
  approved: number;
  approvedBy: string | null;
  sentTo: string | null;
  hasImage: number;
}

export function storePendingApproval(approval: {
  approvalId: string;
  groupName: string;
  tweetId: string;
  tweetJson: string;
  telegramMsgIds: Record<string, number>;
  discordMsgIds: Record<string, string>;
  createdAt: Date;
  approved: boolean;
  hasImage: boolean;
}): void {
  const database = getDatabase();
  database.run(
    `INSERT OR REPLACE INTO pending_approvals (approval_id, group_name, tweet_id, tweet_json, telegram_msg_ids, discord_msg_ids, created_at, approved, has_image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      approval.approvalId,
      approval.groupName,
      approval.tweetId,
      approval.tweetJson,
      JSON.stringify(approval.telegramMsgIds),
      JSON.stringify(approval.discordMsgIds),
      approval.createdAt.getTime(),
      approval.approved ? 1 : 0,
      approval.hasImage ? 1 : 0,
    ]
  );
}

export function markApprovalDone(approvalId: string, approvedBy?: string, sentTo?: string): void {
  const database = getDatabase();
  database.run(
    `UPDATE pending_approvals SET approved = 1, approved_by = ?, sent_to = ? WHERE approval_id = ?`,
    [approvedBy || null, sentTo || null, approvalId]
  );
}

export function deletePendingApproval(approvalId: string): void {
  const database = getDatabase();
  database.run('DELETE FROM pending_approvals WHERE approval_id = ?', [approvalId]);
}

export function getAllPendingApprovals(): PersistedApproval[] {
  const database = getDatabase();
  return database.query('SELECT * FROM pending_approvals WHERE approved = 0').all() as PersistedApproval[];
}

export function getPendingApproval(approvalId: string): PersistedApproval | null {
  const database = getDatabase();
  return (database.query('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as PersistedApproval) || null;
}

export function hasPendingApprovalForTweet(tweetId: string, groupName?: string): boolean {
  const database = getDatabase();
  if (groupName) {
    const row = database.query('SELECT 1 FROM pending_approvals WHERE tweet_id = ? AND group_name = ? AND approved = 0').get(tweetId, groupName);
    return !!row;
  }
  const row = database.query('SELECT 1 FROM pending_approvals WHERE tweet_id = ? AND approved = 0').get(tweetId);
  return !!row;
}

export function storeDeadLetter(tweetId: string, targetLabel: string, targetId: string, errorMessage: string): void {
  const database = getDatabase();
  database.run(
    `INSERT INTO dead_letters (tweet_id, target_label, target_id, error_message, created_at) VALUES (?, ?, ?, ?, ?)`,
    [tweetId, targetLabel, targetId, errorMessage, Date.now()]
  );
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('数据库已关闭');
  }
}
