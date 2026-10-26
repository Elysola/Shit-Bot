import { beforeEach, describe, expect, test } from 'bun:test';
import { getChannel } from './channels';
import { setMeta } from './db/meta';
import { compareSnowflakes } from './identity';
import { backfillChannelTo, pageFrom, syncChannel, type SyncChannel } from './history-sync';
import { countChannelMessages } from './messages';
import { CHANNEL_ID, GUILD_ID, ingestFixture, setupAiTest, snowflakeAt } from '../testing/fixtures';
import type { IngestMessage } from './ingest';

const DAY = 86400000;
const NOW = Date.now();

/** 一个假的频道：messages 按时间从旧到新；fetchBefore 模拟 Discord 的 before 分页（最新的 100 条） */
function fakeChannel(messages: IngestMessage[], opts: { unrecordable?: Set<string> } = {}): SyncChannel & { calls: number } {
  const sorted = [...messages].sort((a, b) => compareSnowflakes(a.messageId, b.messageId));
  const ch = {
    calls: 0,
    info: { channelId: CHANNEL_ID, guildId: GUILD_ID, parentId: null, name: '闲聊', type: 'text' },
    fetchBefore: async (before?: string) => {
      ch.calls++;
      const older = before ? sorted.filter((m) => compareSnowflakes(m.messageId, before) < 0) : sorted;
      const page = older.slice(-100);
      const raw = page.map((m) => ({ id: m.messageId, createdAt: m.createdAt }));
      // 模拟系统消息等无法入库的消息：原始页里有，但不交给入库
      return pageFrom(page.filter((m) => !opts.unrecordable?.has(m.messageId)), raw);
    },
  };
  return ch;
}

/** 生成 n 条消息，时间从 startMs 起每条间隔 stepMs */
function series(n: number, startMs: number, stepMs: number): IngestMessage[] {
  return Array.from({ length: n }, (_, i) => {
    const t = startMs + i * stepMs;
    return ingestFixture({ messageId: snowflakeAt(t), createdAt: t, content: `msg ${i}`, source: 'backfill' });
  });
}

beforeEach(() => setupAiTest({ history: { initialDays: 30, maxMessagesPerChannel: 5000, requestIntervalMs: 0 } }));

describe('syncChannel', () => {
  test('首次同步：从最新往前回望到 initialDays 为止', async () => {
    // 60 天里每 6 小时一条 = 240 条；30 天内约 120 条
    const msgs = series(240, NOW - 60 * DAY, 6 * 3600_000);
    const ch = fakeChannel(msgs);
    const r = await syncChannel(ch, { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r.mode).toBe('initial');
    expect(r.complete).toBe(true);
    expect(r.exhausted).toBe(false);
    // 第二页跨过了 30 天的分界，整页都会入库：100 + 100
    expect(countChannelMessages(CHANNEL_ID)).toBe(200);
    const state = getChannel(CHANNEL_ID)!;
    expect(state.history_complete).toBe(1);
    expect(state.newest_message_id).toBe(msgs[msgs.length - 1].messageId);
  });

  test('频道消息不足一页：标记为已到开头', async () => {
    const ch = fakeChannel(series(30, NOW - DAY, 60_000));
    const r = await syncChannel(ch, { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r).toMatchObject({ complete: true, exhausted: true, inserted: 30 });
    expect(getChannel(CHANNEL_ID)?.history_exhausted).toBe(1);
  });

  test('重启后补缺口：翻到停机前已入库的消息就停', async () => {
    const before = series(150, NOW - 10 * DAY, 3600_000);
    await syncChannel(fakeChannel(before), { now: NOW - 3 * DAY, startedAt: NOW - 3 * DAY, intervalMs: 0 });
    const stored = countChannelMessages(CHANNEL_ID);

    // 停机期间新增 250 条；重启（startedAt = NOW）后同步
    const gap = series(250, NOW - 2 * DAY, 60_000);
    const ch = fakeChannel([...before, ...gap]);
    const r = await syncChannel(ch, { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r.mode).toBe('gap');
    expect(r.gapUnclosed).toBe(false);
    expect(r.inserted).toBe(250);
    expect(countChannelMessages(CHANNEL_ID)).toBe(stored + 250);
    // 3 页：250 条缺口需要 3 页，第 3 页碰到了已知消息就停
    expect(ch.calls).toBe(3);
  });

  test('补缺口中途失败：下次启动不会把失败前写入的那一页当成"接上了"，剩下的缺口照样补齐', async () => {
    const before = series(150, NOW - 10 * DAY, 3600_000);
    await syncChannel(fakeChannel(before), { now: NOW - 3 * DAY, startedAt: NOW - 3 * DAY, intervalMs: 0 });
    const stored = countChannelMessages(CHANNEL_ID);
    const gap = series(300, NOW - 2 * DAY, 60_000);
    // 第一次重启：第一页写入成功，第二页请求失败
    const flaky = fakeChannel([...before, ...gap]);
    const real = flaky.fetchBefore;
    flaky.fetchBefore = async (b?: string) => {
      if (flaky.calls >= 1) throw new Error('网络错误');
      return real(b);
    };
    await expect(syncChannel(flaky, { now: NOW - DAY, startedAt: NOW - DAY, intervalMs: 0 })).rejects.toThrow('网络错误');
    expect(countChannelMessages(CHANNEL_ID)).toBe(stored + 100);
    // 第二次重启：一直补到上次成功同步的位置
    const r = await syncChannel(fakeChannel([...before, ...gap]), { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r.gapUnclosed).toBe(false);
    expect(countChannelMessages(CHANNEL_ID)).toBe(stored + 300);
  });

  test('已经有续传游标时再次中途失败：新的那段缺口也不会被跳过', async () => {
    const before = series(150, NOW - 10 * DAY, 3600_000);
    await syncChannel(fakeChannel(before), { now: NOW - 5 * DAY, startedAt: NOW - 5 * DAY, intervalMs: 0 });
    const stored = countChannelMessages(CHANNEL_ID);
    // 模拟上一次翻页到上限留下的旧缺口：游标指向已入库的最早一条，下沿是它自己（续补时立刻闭合）
    const oldest = before[0].messageId;
    setMeta(`history.gap.${CHANNEL_ID}`, JSON.stringify({ floor: oldest, cursor: oldest }));
    const fresh = series(300, NOW - 2 * DAY, 60_000);
    const flaky = fakeChannel([...before, ...fresh]);
    const real = flaky.fetchBefore;
    flaky.fetchBefore = async (b?: string) => {
      if (flaky.calls >= 1) throw new Error('网络错误');
      return real(b);
    };
    await expect(syncChannel(flaky, { now: NOW - DAY, startedAt: NOW - DAY, intervalMs: 0 })).rejects.toThrow('网络错误');
    const r = await syncChannel(fakeChannel([...before, ...fresh]), { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r.gapUnclosed).toBe(false);
    expect(countChannelMessages(CHANNEL_ID)).toBe(stored + 300);
  });

  test('页里有无法入库的消息时，仍按原始页判断分页和是否到头', async () => {
    const msgs = series(250, NOW - 5 * DAY, 60_000);
    const unrecordable = new Set(msgs.slice(150, 160).map((m) => m.messageId));
    const r = await syncChannel(fakeChannel(msgs, { unrecordable }), { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r.exhausted).toBe(true);
    expect(countChannelMessages(CHANNEL_ID)).toBe(240);
  });

  test('达到每频道条数上限就停止回望', async () => {
    setupAiTest({ history: { initialDays: 3650, maxMessagesPerChannel: 150, requestIntervalMs: 0 } });
    const r = await syncChannel(fakeChannel(series(500, NOW - 100 * DAY, 3600_000)), { now: NOW, startedAt: NOW, intervalMs: 0 });
    expect(r.complete).toBe(true);
    expect(countChannelMessages(CHANNEL_ID)).toBe(200);
  });
});

describe('backfillChannelTo', () => {
  test('按需继续往前补，不受 initialDays 限制，到开头为止', async () => {
    const msgs = series(400, NOW - 300 * DAY, DAY / 2);
    const ch = fakeChannel(msgs);
    await syncChannel(ch, { now: NOW, startedAt: NOW, intervalMs: 0 });
    const afterInitial = countChannelMessages(CHANNEL_ID);
    expect(afterInitial).toBeLessThan(400);
    expect(await backfillChannelTo(ch, 10_000, { intervalMs: 0 })).toBe(400);
    expect(getChannel(CHANNEL_ID)?.history_exhausted).toBe(1);
  });
});
