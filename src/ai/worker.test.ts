import { beforeEach, describe, expect, test } from 'bun:test';
import { getConfig } from '../config';
import { getDatabase } from '../storage';
import { recordUsage } from './llm-client';
import {
  PermanentJobError,
  drainJobs,
  enqueueJob,
  nextUtc8Midnight,
  registerJobHandler,
  runSchedulers,
  registerScheduler,
  type JobRow,
} from './worker';
import { setupAiTest } from '../testing/fixtures';

function job(id: number): JobRow {
  return getDatabase().query('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
}

const order: string[] = [];
let failTimes = 0;

registerJobHandler('decay', async (p) => {
  order.push(String((p as { tag: string }).tag));
});
registerJobHandler('retention', async () => {
  if (failTimes-- > 0) throw new Error('暂时失败');
});
registerJobHandler('embed', async () => {
  throw new PermanentJobError('数据不存在');
});
registerJobHandler('extract_window', async () => {
  order.push('extract');
});

beforeEach(() => {
  setupAiTest({ memory: { enabled: true, extractor: { dailyTokenBudget: 1000 } } });
  order.length = 0;
  failTimes = 0;
});

describe('worker', () => {
  test('同一 dedupe_key 排队中时不重复投递；按优先级执行', async () => {
    const now = Date.now();
    expect(enqueueJob('decay', { tag: 'low' }, { priority: 10, dedupeKey: 'a' }, now)).not.toBeNull();
    expect(enqueueJob('decay', { tag: 'dup' }, { priority: 10, dedupeKey: 'a' }, now)).toBeNull();
    enqueueJob('decay', { tag: 'high' }, { priority: 90 }, now);
    enqueueJob('decay', { tag: 'later' }, { priority: 99, runAfter: now + 60_000 }, now);
    expect(await drainJobs(now)).toBe(2);
    expect(order).toEqual(['high', 'low']);
    // 完成后同一 key 可以再次投递
    expect(enqueueJob('decay', { tag: 'again' }, { dedupeKey: 'a' }, now)).not.toBeNull();
  });

  test('失败指数退避重试；永久错误直接失败；没有处理器的任务留在队列里不动', async () => {
    const now = Date.now();
    failTimes = 1;
    const id = enqueueJob('retention', {}, {}, now)!;
    await drainJobs(now);
    expect(job(id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job(id).run_after).toBe(now + 30_000);
    await drainJobs(now + 30_000);
    expect(job(id).status).toBe('done');

    const bad = enqueueJob('embed', {}, {}, now)!;
    await drainJobs(now);
    expect(job(bad)).toMatchObject({ status: 'failed', last_error: '数据不存在' });

    // 测试文件共用模块：用一个任何地方都不会注册的类型
    const orphan = enqueueJob('no_handler' as JobRow['type'], {}, {}, now)!;
    await drainJobs(now);
    expect(job(orphan)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  test('超过每日 token 预算的抽取类任务顺延到下一个 UTC+8 零点', async () => {
    const now = Date.now();
    recordUsage('extract', 'm', { prompt_tokens: 900, completion_tokens: 200 }, now);
    const id = enqueueJob('extract_window', { channelId: 'c' }, {}, now)!;
    await drainJobs(now);
    expect(order).toEqual([]);
    expect(job(id)).toMatchObject({ status: 'pending', run_after: nextUtc8Midnight(now) });
    // 不受预算约束的任务照常执行
    enqueueJob('decay', { tag: 'free' }, {}, now);
    await drainJobs(now);
    expect(order).toEqual(['free']);
  });

  test('nextUtc8Midnight 与调度器节流', () => {
    // 2026-10-24 23:30 UTC+8 → 2026-10-25 00:00 UTC+8
    const t = Date.UTC(2026, 9, 24, 15, 30);
    expect(nextUtc8Midnight(t)).toBe(Date.UTC(2026, 9, 24, 16, 0));
    let n = 0;
    registerScheduler('test-tick', 60_000, () => n++);
    runSchedulers(1_000_000);
    runSchedulers(1_000_000 + 10_000);
    runSchedulers(1_000_000 + 61_000);
    expect(n).toBe(2);
  });
});

describe('运行时开关（审查修复）', () => {
  test('运行中关掉记忆：依赖记忆的任务不再领取、原样留在队列里；重新打开后继续', async () => {
    let ran = 0;
    // 测试文件共用模块：用本文件已经在覆盖的 embed 类型，不碰提炼 / 画像的真实处理器
    registerJobHandler('embed', async () => {
      ran++;
    });
    const id = enqueueJob('embed', {}, {}, Date.now())!;
    getConfig().ai.memory.enabled = false;
    await drainJobs(Date.now());
    expect(ran).toBe(0);
    expect(job(id).status).toBe('pending');
    getConfig().ai.memory.enabled = true;
    await drainJobs(Date.now());
    expect(ran).toBe(1);
    expect(job(id).status).toBe('done');
  });
});
