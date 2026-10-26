import cron from 'node-cron';
import * as http from 'http';
import { loadConfig, getConfig, getEffectiveGroups } from './config';
import { fetchAllTweets } from './rss/fetcher';
import { filterTweets, getPassedTweets } from './filters';
import { initDiscord, shutdownDiscord, getDiscordClient, registerDiscordCommands, initDiscordAiChat } from './bots/discord';
import { initTelegram, shutdownTelegram, getTelegramBot } from './bots/telegram';
import { initDatabase, closeDatabase, markMultipleAsSent, cleanupOldRecords, cleanupExpiredImages, cleanupOldSentMessages, cleanupOldSentTgMessages } from './storage';
import { sendForApproval, sendToAllGroups, handleTelegramApproval, handleDiscordApproval, setTelegramBot, setDiscordClient, handleRecallCommand, handleRecallMessageContextMenu, handleTelegramRecall, handleDiscordRecall, rehydratePendingApprovals, cleanupExpiredApprovals } from './approval';
import { initRenderer, shutdownRenderer } from './renderer';
import { initTwitterClient, loginWithCredentials } from './twitter';
import { startWebServer } from './web/server';
import { handleAiCommand } from './ai/commands';
import { loadPersonas, stopWatchingPersonas, watchPersonas } from './ai/persona/loader';
import { loadLore, stopWatchingLore, watchLore } from './ai/lore';
import { registerExtraction } from './ai/memory/extract';
import { registerProfiles } from './ai/memory/profile';
import { startWorker, stopWorker } from './ai/worker';
import { registerRetention } from './ai/retention';
import { registerAffinityAndMood } from './ai/appraise';
import { configureSqliteRuntime, initVectors, registerVectorJobs } from './ai/vector/service';
import { Tweet } from './types';

const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
const ts = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
};

console.log = (...args: any[]) => _log(ts(), ...args);
console.warn = (...args: any[]) => _warn(ts(), ...args);
console.error = (...args: any[]) => _error(ts(), ...args);

// 进程级兜底：常驻 bot 以 I/O 为主，单个游离的 Promise 拒绝/未捕获异常只记录、不退出，
// 避免一条边缘消息或某个事件回调的异常把整个进程(Discord/Telegram/轮询/审批/WebUI)拖垮。
process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝(已忽略，避免进程退出):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('未捕获异常(已忽略，避免进程退出):', err);
});

let isRunning = false;
let cronJob: cron.ScheduledTask | null = null;
let webServer: http.Server | null = null;

async function processAndSendTweets(username: string, tweets: Tweet[]): Promise<void> {
  const config = getConfig();
  const groups = getEffectiveGroups();
  let userConfig = undefined;

  for (const g of groups) {
    const u = (g.users || []).find(u => u.username === username);
    if (u) { userConfig = u; break; }
  }

  if (!userConfig) {
    console.warn(`未找到用户 @${username} 的配置`);
    return;
  }

  const processed = filterTweets(tweets, userConfig);
  const passed = getPassedTweets(processed);

  if (passed.length === 0) {
    return;
  }

  console.log(`处理 @${username} 的 ${passed.length} 条推文`);

  if (config.enableApproval) {
    for (const tweet of passed) {
      await sendForApproval(tweet);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } else {
    for (const tweet of passed) {
      await sendToAllGroups(tweet);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  markMultipleAsSent(passed.map(t => ({
    id: t.id,
    author: t.author,
    content: t.content,
    url: t.url,
  })));
}

async function pollAndSend(): Promise<void> {
  if (isRunning) {
    console.log('上一轮轮询仍在进行, 跳过...');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.log(`\n[${new Date().toISOString()}] 开始轮询...`);

    cleanupExpiredImages(getConfig().imageCacheTtlMinutes);
    cleanupExpiredApprovals(60);
    cleanupOldSentMessages(7);
    cleanupOldSentTgMessages(7);

    const allTweets = await fetchAllTweets();

    let totalProcessed = 0;
    let totalPassed = 0;

    for (const [username, tweets] of allTweets) {
      await processAndSendTweets(username, tweets);
      totalProcessed += tweets.length;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`轮询完成, 耗时 ${elapsed}s`);
  } catch (error) {
    console.error('轮询出错:', error);
  } finally {
    isRunning = false;
  }
}

async function start(): Promise<void> {
  console.log('=== X/Twitter 监控 Bot ===\n');

  try {
    loadConfig();
    console.log('配置已加载');
  } catch (error) {
    console.error('配置加载失败:', error);
    process.exit(1);
  }

  // macOS 自带 SQLite 不能加载扩展：配置了自定义 SQLite 时必须在打开数据库之前切换
  configureSqliteRuntime();
  initDatabase();
  rehydratePendingApprovals();

  const config = getConfig();

  if (config.ai.enabled) {
    // 人设卡与 lorebook：启动时加载（目录为空会生成默认 memecat 人设卡），之后改动文件自动生效
    const personaCount = loadPersonas();
    watchPersonas();
    const loreCount = loadLore();
    watchLore();
    console.log(`[Persona] 已加载 ${personaCount} 张人设卡；[Lore] 已加载 ${loreCount} 条设定集条目`);

    // 后台流水线一律注册，执不执行看运行时配置（worker 只领取功能开着的任务、调度器自己检查开关），
    // 这样启动时没开记忆、之后在 WebUI 打开也能立刻工作
    // 记忆：窗口抽取、画像 / 统计 / 反思（任务在 jobs 表里，重启不丢）
    registerExtraction();
    registerProfiles();
    // 好感与情绪：每次互动后的评估、长期未互动回落、旁听好感与群聊气氛
    registerAffinityAndMood();
    // 向量化（配置了向量模型才启用）：自动选择 sqlite-vec 或 JS 后端，后台回填
    await initVectors();
    registerVectorJobs();
    // 保留期清理；主动插话的反馈结算由 Discord 侧注册
    registerRetention();
    startWorker();
  }

  if (config.sendAsImage) {
    console.log('正在初始化图片渲染器...');
    const rendererReady = await initRenderer();
    if (!rendererReady) {
      console.warn('图片渲染器初始化失败, 将以文本形式发送');
    }
  }

  if (config.twitter.enabled !== false) {
    console.log('正在初始化 Twitter 客户端...');
    let twitterReady = await initTwitterClient();

    if (!twitterReady && config.twitter.username && config.twitter.password) {
      console.log('Cookie 无效, 尝试使用凭据登录...');
      try {
        const result = await loginWithCredentials();
        config.twitter.authToken = result.authToken;
        config.twitter.ct0 = result.ct0;
        twitterReady = await initTwitterClient();
      } catch (error) {
        console.error('登录失败:', error);
      }
    }

    if (!twitterReady) {
      console.error('Twitter 客户端初始化失败, 退出程序.');
      process.exit(1);
    }
  } else {
    console.log('Twitter 推文监控已禁用 (twitter.enabled: false)');
  }

  let discordReady = false;
  let telegramReady = false;

  if (config.discord.enabled) {
    discordReady = await initDiscord();
    if (!discordReady) {
      console.warn('Discord 初始化失败');
    }
  }

  if (config.telegram.enabled) {
    telegramReady = await initTelegram();
    if (!telegramReady) {
      console.warn('Telegram 初始化失败');
    } else {
      const telegramBot = getTelegramBot();
      if (telegramBot) {
        setTelegramBot(telegramBot);
        
        telegramBot.action(/^approve_/, handleTelegramApproval);
        telegramBot.action(/^reject_/, handleTelegramApproval);
        telegramBot.action(/^post_/, handleTelegramApproval);
        telegramBot.action(/^recall_/, handleTelegramRecall);
        
        telegramBot.launch().catch((e) =>
          console.error('Telegram 轮询启动/运行失败:', (e as Error)?.message || e)
        );
        console.log('Telegram bot 已启动, 审批处理器已注册');
      }
    }
  }

  if (config.discord.enabled && discordReady) {
    const discordClient = getDiscordClient();
    if (discordClient) {
      setDiscordClient(discordClient);

      await registerDiscordCommands();

      initDiscordAiChat();

      discordClient.on('interactionCreate', async (interaction) => {
        // 整个分发器包一层兜底：交互 3s token 过期或瞬时网络错误导致 reply 抛错时，
        // 只记录日志、不让其逃逸成未处理拒绝(一次交互失败不应影响机器人存活)。
        try {
          if (interaction.isMessageContextMenuCommand()) {
            await handleRecallMessageContextMenu(interaction);
            return;
          }
          if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'recall') {
              await handleRecallCommand(interaction);
            } else {
              await handleAiCommand(interaction);
            }
            return;
          }
          if (!interaction.isButton()) return;
          const customId = interaction.customId;
          if (customId.startsWith('recall_')) {
            await handleDiscordRecall(interaction);
            return;
          }
          if (customId.startsWith('approve_') || customId.startsWith('reject_') || customId.startsWith('post_')) {
            await handleDiscordApproval(interaction);
          }
        } catch (e) {
          console.error('[交互处理] 未捕获异常(已忽略):', (e as Error)?.message || e);
        }
      });
      console.log('Discord 审批处理器已注册');
    }
  }

  if (config.discord.enabled && !discordReady && config.telegram.enabled && !telegramReady) {
    console.error('Discord 和 Telegram 均初始化失败, 退出程序.');
    process.exit(1);
  }

  webServer = startWebServer();

  if (config.twitter.enabled === false) {
    console.log('\n仅运行 AI 聊天 / WebUI (Twitter 推文监控已禁用)。');
    return;
  }

  const groups = getEffectiveGroups();
  const uniqueUsers = new Map<string, string>();
  for (const g of groups) {
    for (const u of (g.users || [])) {
      uniqueUsers.set(u.username, u.displayName || u.username);
    }
  }

  console.log(`\n正在监控 ${uniqueUsers.size} 个用户:`);
  for (const username of uniqueUsers.keys()) {
    console.log(`  - @${username}`);
  }

  console.log(`\n轮询间隔: ${config.pollIntervalMinutes} 分钟`);
  console.log('开始首次轮询...\n');

  await pollAndSend();

  const cronExpression = `*/${config.pollIntervalMinutes} * * * *`;
  cronJob = cron.schedule(cronExpression, pollAndSend);
  console.log(`定时任务已设置: ${cronExpression}`);
}

async function shutdown(): Promise<void> {
  console.log('\n正在关闭...');

  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  if (webServer) {
    webServer.close();
    webServer = null;
  }

  await shutdownDiscord();
  await shutdownTelegram();
  await shutdownRenderer();
  stopWorker();
  stopWatchingPersonas();
  stopWatchingLore();
  closeDatabase();

  console.log('关闭完成');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((error) => {
  console.error('致命错误:', error);
  process.exit(1);
});
