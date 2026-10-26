import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits } from 'discord.js';
import { buildIntents, decidePrivilegedIntents, isDisallowedIntentsError, privilegedFromFlags } from './discord-intents';

function flagsFetch(flags: number | null, status = 200): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response(JSON.stringify(flags === null ? {} : { flags }), { status });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => calls };
}

describe('privilegedFromFlags', () => {
  test('完整版与 LIMITED 版标志位都算开启', () => {
    expect(privilegedFromFlags(0)).toEqual({ members: false, presences: false });
    expect(privilegedFromFlags(1 << 13)).toEqual({ members: false, presences: true });
    expect(privilegedFromFlags(1 << 15)).toEqual({ members: true, presences: false });
    expect(privilegedFromFlags((1 << 12) | (1 << 14) | (1 << 19))).toEqual({ members: true, presences: true });
  });
});

describe('decidePrivilegedIntents', () => {
  test('auto 按标志位决定（当前应用：只有消息内容权限）', async () => {
    const f = flagsFetch(1 << 19);
    expect(await decidePrivilegedIntents('t', { members: 'auto', presences: 'auto' }, f.fetch)).toEqual({
      members: false,
      presences: false,
      flags: 1 << 19,
    });
  });

  test('on/off 直接生效，都不是 auto 时不请求接口', async () => {
    const f = flagsFetch(0);
    expect(await decidePrivilegedIntents('t', { members: 'on', presences: 'off' }, f.fetch)).toEqual({
      members: true,
      presences: false,
      flags: null,
    });
    expect(f.calls()).toBe(0);
  });

  test('读取失败时 auto 按未开启处理，保证能登录', async () => {
    const f = flagsFetch(null, 401);
    expect(await decidePrivilegedIntents('t', { members: 'auto', presences: 'on' }, f.fetch)).toEqual({
      members: false,
      presences: true,
      flags: null,
    });
  });
});

describe('buildIntents / isDisallowedIntentsError', () => {
  test('基础 intent 总是包含表情反应；特权 intent 按需追加', () => {
    const base = buildIntents({ members: false, presences: false });
    expect(base).toContain(GatewayIntentBits.GuildMessageReactions);
    expect(base).not.toContain(GatewayIntentBits.GuildMembers);
    const full = buildIntents({ members: true, presences: true });
    expect(full).toEqual(expect.arrayContaining([GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences]));
  });

  test('识别 4014 / disallowed intents 错误', () => {
    expect(isDisallowedIntentsError(new Error('Used disallowed intents'))).toBe(true);
    expect(isDisallowedIntentsError({ code: 'DisallowedIntents', message: '' })).toBe(true);
    expect(isDisallowedIntentsError({ code: 4014 })).toBe(true);
    expect(isDisallowedIntentsError(new Error('An invalid token was provided.'))).toBe(false);
  });
});
