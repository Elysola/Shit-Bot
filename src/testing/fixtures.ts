import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setConfigForTesting } from '@/config';
import { getDatabase, initDatabase } from '@/storage';
import { migrateAiSchema } from '@/plugins/ai-chat/db/schema';
import type { DiscordUserInfo, MemberInfo } from '@/plugins/ai-chat/identity';
import type { IngestMessage } from '@/plugins/ai-chat/ingest';
import { renderDiscordContent, type MentionResolver, type PersonRef } from '@/plugins/ai-chat/mentions';

export const SELF_ID = '900000000000000001';
export const GUILD_ID = '800000000000000001';
export const CHANNEL_ID = '700000000000000001';

const DISCORD_EPOCH = 1420070400000n;
let counter = 0n;

/** 生成一个创建时间为 atMs 的 snowflake（同一毫秒内也保证递增） */
export function snowflakeAt(atMs: number): string {
  counter = (counter + 1n) % 4096n;
  return (((BigInt(atMs) - DISCORD_EPOCH) << 22n) | counter).toString();
}

let tmpRoot: string | null = null;
let tmpSeq = 0;

/** 测试专用的临时目录（进程内唯一，每次调用返回一个新的空子目录）；绝不写进仓库的 data/ */
export function testTempDir(prefix: string): string {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shitbot-test-'));
  const dir = path.join(tmpRoot, `${prefix}-${++tmpSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 每个测试前调用：内存库 + 开启 AI 与记忆的最小配置；人设卡与 lorebook 目录指向新的临时目录 */
export function setupAiTest(ai: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): void {
  setConfigForTesting({
    twitter: { enabled: false },
    discord: { enabled: false, token: 'x' },
    ...extra,
    plugins: [
      {
        name: 'ai-chat',
        enabled: true,
        options: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          apiKey: 'k',
          model: 'chat-m',
          memory: { enabled: true },
          persona: { dir: testTempDir('personas') },
          lore: { dir: testTempDir('lore') },
          ...ai,
        },
      },
    ],
  });
  initDatabase(':memory:');
  // AI 表由插件在启动时迁移（onAfterInit）；测试里直接建
  migrateAiSchema(getDatabase(), { quiet: true });
}

export type FakeLlmRequest = { url: string; body: Record<string, unknown>; system: string; user: string };

/**
 * 用假的 LLM 替换 fetch：respond 收到请求（含拼好的 system / user 文本），返回字符串（作为 content）或完整响应对象。
 * 返回请求记录与还原函数；测试结束务必调用 restore。
 */
export function installFakeLlm(respond: (req: FakeLlmRequest) => string | Record<string, unknown>): { calls: FakeLlmRequest[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: FakeLlmRequest[] = [];
  const textOf = (c: unknown): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('\n') : '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const msgs = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
    const req: FakeLlmRequest = {
      url: String(url),
      body,
      system: msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'),
      user: msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n'),
    };
    calls.push(req);
    const out = respond(req);
    const payload = typeof out === 'string' ? { choices: [{ message: { content: out }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } } : out;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

export function userInfo(id: string, username: string, extra: Partial<DiscordUserInfo> = {}): DiscordUserInfo {
  return { id, username, globalName: null, avatarUrl: null, isBot: false, ...extra };
}

export function memberInfo(userId: string, extra: Partial<MemberInfo> = {}): MemberInfo {
  return { guildId: GUILD_ID, userId, ...extra };
}

export function personRef(id: string, displayName: string, extra: Partial<PersonRef> = {}): PersonRef {
  return {
    id,
    username: displayName.toLowerCase(),
    globalName: null,
    nickname: null,
    displayName,
    isBot: false,
    isSelf: id === SELF_ID,
    roles: [],
    joinedAt: null,
    ...extra,
  };
}

export function resolverOf(people: PersonRef[]): MentionResolver {
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    user: (id) => byId.get(id) ?? null,
    role: () => null,
    channel: (id) => (id === CHANNEL_ID ? { id, name: '闲聊' } : null),
  };
}

export type IngestFixture = Partial<Omit<IngestMessage, 'author'>> & {
  authorId?: string;
  username?: string;
  nickname?: string | null;
  content?: string;
  people?: PersonRef[];
};

/** 构造一条待入库的消息；正文里的 <@id> 用 people 解析 */
export function ingestFixture(f: IngestFixture = {}): IngestMessage {
  const createdAt = f.createdAt ?? Date.now();
  const authorId = f.authorId ?? '100000000000000001';
  const username = f.username ?? 'alice';
  const content = f.content ?? '你好';
  const rendered = f.rendered ?? renderDiscordContent(content, resolverOf(f.people ?? []));
  return {
    messageId: f.messageId ?? snowflakeAt(createdAt),
    guildId: f.guildId ?? GUILD_ID,
    guildName: f.guildName ?? '测试服',
    channel: f.channel ?? { channelId: CHANNEL_ID, guildId: GUILD_ID, parentId: null, name: '闲聊', type: 'text' },
    author: {
      user: userInfo(authorId, username, { isBot: f.kind !== undefined && f.kind !== 'user' }),
      member: f.nickname !== undefined ? memberInfo(authorId, { nickname: f.nickname }) : null,
    },
    kind: f.kind ?? 'user',
    proactive: f.proactive,
    replyToId: f.replyToId ?? null,
    replyToAuthorId: f.replyToAuthorId ?? null,
    contentRaw: content,
    rendered,
    mentionedMembers: f.mentionedMembers ?? [],
    attachments: f.attachments ?? [],
    createdAt,
    editedAt: f.editedAt ?? null,
    source: f.source ?? 'live',
    addressed: f.addressed,
  };
}
