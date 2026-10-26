import { beforeEach, describe, expect, test } from 'bun:test';
import { getDatabase } from '../storage';
import { setOptOut, upsertUser } from './identity';
import { applyPresence, describePresence, flushPresenceSessions, forgetPresence, topActivities, type PresenceInfo } from './presence';
import { setupAiTest, userInfo } from '../testing/fixtures';

const U = '100000000000000001';
const MIN = 60_000;

function presence(activities: PresenceInfo['activities'], status: PresenceInfo['status'] = 'online'): PresenceInfo {
  return { userId: U, status, devices: ['mobile'], activities };
}

function sessions(): Array<{ name: string; started_at: number; ended_at: number }> {
  return getDatabase().query('SELECT name, started_at, ended_at FROM activity_sessions ORDER BY id').all() as Array<{
    name: string;
    started_at: number;
    ended_at: number;
  }>;
}

const genshin = { type: 'playing' as const, name: '原神', details: null, state: null, startedAt: null };

beforeEach(() => {
  setupAiTest();
  upsertUser(userInfo(U, 'alice'), Date.now());
});

describe('applyPresence', () => {
  test('活动结束且时长 ≥ 5 分钟才记一次会话；重复事件幂等', () => {
    const t0 = 1_000_000_000_000;
    applyPresence(presence([genshin]), t0);
    applyPresence(presence([genshin]), t0 + MIN); // 另一个服务器的重复事件
    applyPresence(presence([]), t0 + 30 * MIN);
    expect(sessions()).toEqual([{ name: '原神', started_at: t0, ended_at: t0 + 30 * MIN }]);

    applyPresence(presence([genshin]), t0 + 40 * MIN);
    applyPresence(presence([]), t0 + 42 * MIN);
    expect(sessions()).toHaveLength(1);
  });

  test('下线时关闭所有活动；退出进程时 flush 进行中的活动', () => {
    const t0 = 1_000_000_000_000;
    applyPresence(presence([genshin, { type: 'listening', name: 'Spotify', details: '晴天', state: '周杰伦', startedAt: null }]), t0);
    applyPresence(presence([], 'offline'), t0 + 10 * MIN);
    expect(sessions().map((s) => s.name).sort()).toEqual(['Spotify', '原神']);
    expect(describePresence(U)).toBeNull();

    applyPresence(presence([genshin]), t0 + 20 * MIN);
    flushPresenceSessions(t0 + 50 * MIN);
    expect(sessions()).toHaveLength(3);
    expect(topActivities(U, 30, 5, t0 + 60 * MIN)[0]).toEqual({ type: 'playing', name: '原神', hours: 0.7 });
  });

  test('一句话描述：状态、设备、活动、自定义状态', () => {
    applyPresence(
      presence([
        genshin,
        { type: 'custom', name: 'Custom Status', details: null, state: '摸鱼中', startedAt: null },
        { type: 'listening', name: 'Spotify', details: '晴天', state: null, startedAt: null },
      ])
    );
    expect(describePresence(U)).toBe('在线（手机） · 正在玩 原神 · 状态：摸鱼中 · 正在听 Spotify《晴天》');
  });

  test('不认识或已 optout 的用户不跟踪', () => {
    applyPresence({ ...presence([genshin]), userId: '100000000000000099' });
    expect(describePresence('100000000000000099')).toBeNull();
    setOptOut(U, true);
    applyPresence(presence([genshin]));
    expect(describePresence(U)).toBeNull();
  });
});

describe('退出记录（审查修复）', () => {
  test('/optout 时丢掉当前状态和未结束的活动；之后关闭也不会把活动落库', () => {
    const t0 = Date.now() - 60 * MIN;
    applyPresence(presence([genshin]), t0);
    setOptOut(U, true);
    forgetPresence(U);
    expect(describePresence(U)).toBeNull();
    flushPresenceSessions(t0 + 30 * MIN);
    expect(sessions()).toEqual([]);
  });

  test('即使没调用 forgetPresence，已退出的人的活动在结束时也不落库', () => {
    const t0 = Date.now() - 60 * MIN;
    applyPresence(presence([genshin]), t0);
    setOptOut(U, true);
    flushPresenceSessions(t0 + 30 * MIN);
    expect(sessions()).toEqual([]);
  });
});
