import * as cron from "node-cron";
import * as http from "http";
import { loadConfig, getConfig, getEffectiveGroups } from "@/config";
import { fetchAllTweets } from "@/rss/fetcher";
import { filterTweets, getPassedTweets } from "@/filters";
import { initDiscord, shutdownDiscord, getDiscordClient, registerDiscordCommands } from "@/bots/discord";
import { initTelegram, shutdownTelegram, getTelegramBot } from "@/bots/telegram";
import { initOneBot, shutdownOneBot, setOneBotMessageHandler, isOneBotConnected } from "@/bots/onebot";
import {
  initDatabase,
  closeDatabase,
  markMultipleAsSent,
  cleanupOldRecords,
  cleanupExpiredImages,
  cleanupOldSentMessages,
  cleanupOldSentTgMessages,
  cleanupCorruptedApprovals,
} from "@/storage";
import {
  sendForApproval,
  sendToAllGroups,
  handleTelegramApproval,
  handleDiscordApproval,
  setTelegramBot,
  setDiscordClient,
  handleRecallCommand,
  handleRecallMessageContextMenu,
  handleTelegramRecall,
  handleDiscordRecall,
  cleanupExpiredApprovals,
} from "@/approval";
import { initRenderer, shutdownRenderer } from "@/renderer";
import { initTwitterClient, loginWithCredentials } from "@/twitter";
import { startWebServer } from "@/web/server";
import {
  loadPlugins,
  executeHook,
  executeTweetHook,
  executeTelegramMessageHook,
  executeOneBotMessageHook,
  getPluginCronJobs,
  shutdownPlugins,
  setDiscordClientProvider,
  setTelegramBotProvider,
} from "@/plugins";
import { Tweet } from "@/types";
import { logger } from "@/logger";

// 进程级兜底：常驻 bot 以 I/O 为主，单个游离的 Promise 拒绝/未捕获异常只记录、不退出，
// 避免一条边缘消息或某个事件回调的异常把整个进程(Discord/Telegram/轮询/审批/WebUI)拖垮。
process.on("unhandledRejection", (reason) => {
  logger.error("Main", "未处理的 Promise 拒绝(已忽略，避免进程退出):", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Main", "未捕获异常(已忽略，避免进程退出):", err);
});

let isRunning = false;
let cronJob: cron.ScheduledTask | null = null;
let webServer: http.Server | null = null;

async function processAndSendTweets(username: string, tweets: Tweet[]): Promise<void> {
  const config = getConfig();
  const groups = getEffectiveGroups();
  let userConfig = undefined;

  for (const g of groups) {
    const u = (g.users || []).find((u) => u.username === username);
    if (u) {
      userConfig = u;
      break;
    }
  }

  if (!userConfig) {
    logger.warn("Main", `未找到用户 @${username} 的配置`);
    return;
  }

  const filteredTweets: Tweet[] = [];
  for (const tweet of tweets) {
    const result = await executeTweetHook(tweet);
    if (result === null) continue;
    filteredTweets.push(result);
  }

  const processed = filterTweets(filteredTweets, userConfig);
  const passed = getPassedTweets(processed);

  if (passed.length === 0) {
    return;
  }

  logger.info("Main", `处理 @${username} 的 ${passed.length} 条推文`);

  const configForApproval = config.enableApproval;

  if (configForApproval) {
    for (const tweet of passed) {
      await sendForApproval(tweet);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } else {
    for (const tweet of passed) {
      await sendToAllGroups(tweet);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  markMultipleAsSent(
    passed.map((t) => ({
      id: t.id,
      author: t.author,
      content: t.content,
      url: t.url,
    })),
  );
}

async function pollAndSend(): Promise<void> {
  if (isRunning) {
    logger.info("Main", "上一轮轮询仍在进行, 跳过...");
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    logger.info("Main", `\n[${new Date().toISOString()}] 开始轮询...`);

    await executeHook("onBeforePoll");

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
    logger.info("Main", `轮询完成, 耗时 ${elapsed}s`);

    await executeHook("onAfterPoll", {
      allTweets,
      totalFetched: totalProcessed,
      totalProcessed,
      totalPassed,
      totalSent: totalPassed,
      elapsedSeconds: parseFloat(elapsed),
    });
  } catch (error) {
    logger.error("Main", "轮询出错:", error);
  } finally {
    isRunning = false;
  }
}

async function start(): Promise<void> {
  logger.info("Main", "=== X/Twitter 监控 Bot ===\n");

  try {
    loadConfig();
    logger.info("Main", "配置已加载");
  } catch (error) {
    logger.error("Main", "配置加载失败:", error);
    process.exit(1);
  }

  const proxyUrl = getConfig().proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
    logger.info("Main", `全局代理已设置: ${proxyUrl}`);
  }

  await loadPlugins();
  await executeHook("onConfigLoaded", getConfig());

  initDatabase();
  cleanupCorruptedApprovals();

  const config = getConfig();

  if (config.sendAsImage) {
    logger.info("Main", "正在初始化图片渲染器...");
    const rendererReady = await initRenderer();
    if (!rendererReady) {
      logger.warn("Main", "图片渲染器初始化失败, 将以文本形式发送");
    }
  }

  if (config.twitter.enabled !== false) {
    logger.info("Main", "正在初始化 Twitter 客户端...");
    let twitterReady = await initTwitterClient();

    if (!twitterReady && config.twitter.username && config.twitter.password) {
      logger.info("Main", "Cookie 无效, 尝试使用凭据登录...");
      try {
        const result = await loginWithCredentials();
        config.twitter.authToken = result.authToken;
        config.twitter.ct0 = result.ct0;
        twitterReady = await initTwitterClient();
      } catch (error) {
        logger.error("Main", "登录失败:", error);
      }
    }

    if (!twitterReady) {
      logger.error("Main", "Twitter 客户端初始化失败, 退出程序.");
      process.exit(1);
    }
  } else {
    logger.info("Main", "Twitter 推文监控已禁用 (twitter.enabled: false)");
  }

  let discordReady = false;
  let telegramReady = false;

  if (config.discord.enabled) {
    discordReady = await initDiscord();
    if (!discordReady) {
      logger.warn("Main", "Discord 初始化失败");
    }
  }

  setDiscordClientProvider(() => getDiscordClient());
  setTelegramBotProvider(() => getTelegramBot());

  if (config.telegram.enabled) {
    telegramReady = await initTelegram();
    if (!telegramReady) {
      logger.warn("Main", "Telegram 初始化失败");
    } else {
      const telegramBot = getTelegramBot();
      if (telegramBot) {
        setTelegramBot(telegramBot);

        telegramBot.action(/^approve_/, handleTelegramApproval);
        telegramBot.action(/^reject_/, handleTelegramApproval);
        telegramBot.action(/^post_/, handleTelegramApproval);
        telegramBot.action(/^recall_/, handleTelegramRecall);

        // 文本消息 → 插件钩子（如 jm-daily 的 /jm 命令），返回 true 表示插件已处理
        telegramBot.on("message", async (ctx) => {
          try {
            const claimed = await executeTelegramMessageHook(ctx);
            if (claimed) {
              logger.info("Main", "Telegram 消息已被插件处理");
            }
          } catch (e) {
            logger.error("Main", "Telegram 插件消息处理失败:", (e as Error)?.message || e);
          }
        });

        telegramBot
          .launch()
          .catch((e) => logger.error("Main", "Telegram 轮询启动/运行失败:", (e as Error)?.message || e));
        logger.info("Main", "Telegram bot 已启动, 审批处理器已注册");
      }
    }
  }

  if (config.discord.enabled && discordReady) {
    const discordClient = getDiscordClient();
    if (discordClient) {
      setDiscordClient(discordClient);

      await registerDiscordCommands();

      discordClient.on("interactionCreate", async (interaction) => {
        // 整个分发器包一层兜底：交互 3s token 过期或瞬时网络错误导致 reply 抛错时，
        // 只记录日志、不让其逃逸成未处理拒绝(一次交互失败不应影响机器人存活)。
        try {
          if (interaction.isMessageContextMenuCommand()) {
            await handleRecallMessageContextMenu(interaction);
            return;
          }
          if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "recall") {
              await handleRecallCommand(interaction);
            }
            return;
          }
          if (!interaction.isButton()) return;
          const customId = interaction.customId;
          if (customId.startsWith("recall_")) {
            await handleDiscordRecall(interaction);
            return;
          }
          if (customId.startsWith("approve_") || customId.startsWith("reject_") || customId.startsWith("post_")) {
            await handleDiscordApproval(interaction);
          }
        } catch (e) {
          logger.error("Main", "[交互处理] 未捕获异常(已忽略):", (e as Error)?.message || e);
        }
      });
      logger.info("Main", "Discord 审批处理器已注册");
    }
  }

  if (config.onebot.enabled) {
    const onebotReady = await initOneBot();
    if (onebotReady) {
      setOneBotMessageHandler(async (message) => {
        // 插件消息钩子（如 jm-daily 的 /jm 命令），返回 true 表示插件已处理
        const pluginClaimed = await executeOneBotMessageHook(message).catch(() => false);
        if (pluginClaimed) return;

        const raw = message.raw_message || "";
        const approvalMatch = raw.match(/\/approve\s+(.+)/);
        const rejectMatch = raw.match(/\/reject\s+(.+)/);
        if ((approvalMatch || rejectMatch) && message.group_id) {
          const approvalId = (approvalMatch || rejectMatch)![1].trim();
          const reject = !!rejectMatch;
          logger.info("Main", `收到${reject ? "拒绝" : "批准"}指令: ${approvalId}`);
          const { handleOneBotApproval } = await import("@/approval");
          await handleOneBotApproval(approvalId, message.user_id, message.group_id, reject);
        }
      });
      logger.info("Main", "OneBot 审批处理器已注册");
    }
  }

  const anyBotEnabled =
    (config.discord.enabled && discordReady) ||
    (config.telegram.enabled && telegramReady) ||
    (config.onebot.enabled && isOneBotConnected());
  if (!anyBotEnabled) {
    logger.error("Main", "所有 Bot 均初始化失败, 退出程序.");
    process.exit(1);
  }

  await executeHook("onAfterInit");

  webServer = startWebServer();

  if (config.twitter.enabled === false) {
    logger.info("Main", "\n仅运行 AI 聊天 / WebUI (Twitter 推文监控已禁用)。");
    return;
  }

  const groups = getEffectiveGroups();
  const uniqueUsers = new Map<string, string>();
  for (const g of groups) {
    for (const u of g.users || []) {
      uniqueUsers.set(u.username, u.displayName || u.username);
    }
  }

  logger.info("Main", `\n正在监控 ${uniqueUsers.size} 个用户:`);
  for (const username of uniqueUsers.keys()) {
    logger.info("Main", `  - @${username}`);
  }

  logger.info("Main", `\n轮询间隔: ${config.pollIntervalMinutes} 分钟`);

  if (config.debugMode) {
    logger.info("Main", "⚠️  调试模式: 跳过自动轮询, 仅通过 API 手动发送");
  } else {
    logger.info("Main", "开始首次轮询...\n");
    await pollAndSend();

    const cronExpression = `*/${config.pollIntervalMinutes} * * * *`;
    cronJob = cron.schedule(cronExpression, pollAndSend);
    logger.info("Main", `定时任务已设置: ${cronExpression}`);
  }

  for (const pc of getPluginCronJobs()) {
    cron.schedule(pc.expression, pc.handler);
    logger.info("Main", `[插件] 已注册定时任务: ${pc.expression}`);
  }
}

async function shutdown(): Promise<void> {
  logger.info("Main", "\n正在关闭...");

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
  await shutdownPlugins();
  closeDatabase();

  logger.info("Main", "关闭完成");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
  logger.error("Main", "致命错误:", error);
  process.exit(1);
});
