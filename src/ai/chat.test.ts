import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '../storage';
import { chatWithAI } from './chat';
import { upsertMember, upsertUser } from './identity';
import { addMemory } from './memory/store';
import { GUILD_ID, memberInfo, personRef, setupAiTest, userInfo } from '../testing/fixtures';

const realFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>> = [];

function respondWith(status: number, body: unknown): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(() => {
  bodies = [];
  setupAiTest({ maxTokens: 256, temperature: 0.5, memory: { enabled: false } });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('chatWithAI（重构回归）', () => {
  test('请求体与以前一致：模型、温度、max_tokens、工具；回复正常返回并记账为 chat', async () => {
    respondWith(200, { choices: [{ message: { content: '你好呀' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    const res = await chatWithAI('你好', { platform: 'telegram', username: 'u1', displayName: '小明' });
    expect(res).toMatchObject({ reply: '你好呀', reactions: [] });
    expect(bodies).toHaveLength(1);
    const b = bodies[0];
    expect(b.model).toBe('chat-m');
    expect(b.temperature).toBe(0.5);
    expect(b.max_tokens).toBe(256);
    expect(b.tool_choice).toBe('auto');
    expect((b.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toContain('read_image');
    const msgs = b.messages as Array<{ role: string; content: string }>;
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '[小明]: 你好' });
    // ① 人设卡：没有人设卡文件时自动生成 memecat，并作为第一条系统消息
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content.startsWith('# 你的身份\n你是「memecat」。')).toBe(true);
    expect(getDatabase().query('SELECT purpose, calls FROM llm_usage').get()).toEqual({ purpose: 'chat', calls: 1 });
  });

  test('开启记忆：注入记忆规则与说话人核心档案，并提供记忆工具；返回可提醒的用户 ID', async () => {
    setupAiTest({ memory: { enabled: true } });
    const A = '100000000000000001';
    upsertUser(userInfo(A, 'alice'), Date.now());
    upsertMember(memberInfo(A, { nickname: '阿丽' }), userInfo(A, 'alice'), Date.now());
    addMemory({ scope: 'user', subjectId: A, kind: 'preference', content: '最爱吃火锅', importance: 9, origin: 'extractor' });
    respondWith(200, { choices: [{ message: { content: '吃火锅去！' }, finish_reason: 'stop' }] });

    const res = await chatWithAI('晚上吃啥', {
      platform: 'telegram',
      userId: A,
      username: 'alice',
      displayName: '阿丽',
      guildId: GUILD_ID,
      speaker: personRef(A, '阿丽'),
    });
    expect(res.mentionableIds).toEqual([A]);
    const msgs = bodies[0].messages as Array<{ role: string; content: string }>;
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
    expect(system).toContain('[记忆使用规则]');
    expect(system).toContain('[核心档案：正在和你说话的人]');
    expect(system).toContain('最爱吃火锅');
    const toolNames = (bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(['search_memory', 'get_person', 'remember']));
  });

  test('鉴权失败时返回友好提示而不是抛错', async () => {
    respondWith(401, 'unauthorized');
    const res = await chatWithAI('你好', { platform: 'telegram' });
    expect(res.reply).toBe('AI 服务返回错误 (401)。请检查 API 配置。');
  });
});

describe('autoRecall（审查修复）', () => {
  test('memory.context.autoRecall > 0：按本条消息自动带上相关的档案记忆（已置顶的不重复）', async () => {
    setupAiTest({ memory: { enabled: true, context: { autoRecall: 2 } } });
    const A = '100000000000000001';
    upsertUser(userInfo(A, 'alice'), Date.now());
    addMemory({ scope: 'user', subjectId: A, kind: 'fact', content: '阿丽在准备考研究生', importance: 3, pinned: false, origin: 'extractor' });
    respondWith(200, { choices: [{ message: { content: '加油' }, finish_reason: 'stop' }] });
    await chatWithAI('考研究生好难', { platform: 'discord', userId: A, username: 'alice', displayName: '阿丽', guildId: GUILD_ID });
    const sys = (bodies[0].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).toContain('可能相关的记忆');
    expect(sys).toContain('阿丽在准备考研究生');
  });
});
