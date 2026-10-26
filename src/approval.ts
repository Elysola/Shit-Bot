import { Context, Markup } from "telegraf";
import { logger } from "@/logger";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
  ButtonInteraction,
  Client,
  AttachmentBuilder,
  MessageFlags,
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
} from "discord.js";
import { executeHook, executeBeforeSendHook, executeBeforeApprovalHook } from "@/plugins";
import { sendToOneBot, sendTextToOneBot, deleteOneBotMessage, isOneBotConnected } from "@/bots/onebot";
import { ProcessedTweet, GroupConfig } from "./types";
import { getConfig, getEffectiveGroups } from "./config";
import { formatTweetHTML, escapeHTML, formatContentForPlatform } from "./filters";
import { sendToTelegram } from "./bots/telegram";
import { sendToDiscord, recallMessages, recallMessageById } from "./bots/discord";
import {
  markAsSent,
  cacheImage,
  getCachedImage,
  getSentDiscordMessagesByTweetId,
  getSentTgMessagesByTweetId,
  getSentOneBotMessagesByTweetId,
  deleteSentMessage,
  deleteSentTgMessage,
  deleteSentOneBotMessage,
  storePendingApproval,
  deletePendingApproval,
  markApprovalDone,
  claimApproval,
  getAllPendingApprovals,
  getPendingApproval,
  hasPendingApprovalForTweet,
  storeDeadLetter,
} from "./storage";
import { renderTweetImage } from "./renderer";

interface PendingApproval {
  id: string;
  groupName: string;
  tweet: ProcessedTweet;
  telegramMessageIds: Map<string, number>;
  discordMessageIds: Map<string, string>;
  onebotMessageIds: Map<string, number>;
  createdAt: Date;
  approved: boolean;
  approvedBy?: string;
  sentTo?: string;
  hasImage: boolean;
}

interface TargetResult {
  label: string;
  success: boolean;
  error?: string;
}

interface SendResults {
  total: number;
  succeeded: number;
  failed: number;
  targets: TargetResult[];
}

let telegramBotInstance: any = null;
let discordClientInstance: Client | null = null;

function isConfiguredAdminChannel(channelId: string): boolean {
  const groups = getEffectiveGroups();
  return groups.some((g) => g.approval?.discordAdminChannelId === channelId);
}

function loadApproval(id: string): PendingApproval | undefined {
  if (!id) return undefined;
  const p = getPendingApproval(id);
  if (!p) {
    logger.warn("审批", `[审批] 审批记录 ${id} 在数据库中未找到`);
    return undefined;
  }
  if (!p.tweetJson) {
    logger.warn("审批", `[审批] 审批记录 ${id} 缺少 tweet 数据`);
    deletePendingApproval(id);
    return undefined;
  }
  try {
    const tweet = JSON.parse(p.tweetJson) as ProcessedTweet;
    if (typeof tweet.publishedAt === "string") {
      tweet.publishedAt = new Date(tweet.publishedAt);
    }
    return {
      id: p.approvalId,
      groupName: p.groupName,
      tweet,
      telegramMessageIds: new Map(Object.entries(JSON.parse(p.telegramMsgIds || "{}"))),
      discordMessageIds: new Map(Object.entries(JSON.parse(p.discordMsgIds || "{}"))),
      onebotMessageIds: new Map(Object.entries(JSON.parse(p.onebotMsgIds || "{}"))),
      createdAt: new Date(p.createdAt),
      approved: p.approved !== 0,
      approvedBy: p.approvedBy || undefined,
      sentTo: p.sentTo || undefined,
      hasImage: p.hasImage !== 0,
    };
  } catch (err) {
    logger.error("审批", `[审批] 加载审批记录 ${id} 解析失败:`, err);
    deletePendingApproval(id);
    return undefined;
  }
}

export function rehydratePendingApprovals(): number {
  const persisted = getAllPendingApprovals();
  logger.info("审批", `[恢复] 数据库中有 ${persisted.length} 条待审批记录(已直接从数据库读取，无需预热)`);
  return persisted.length;
}

async function retryWithDelay<T>(fn: () => Promise<T>, retries: number = 3, delayMs: number = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      logger.warn("审批", `[重试] 第 ${i + 1}/${retries} 次, 错误: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("已达最大重试次数");
}

function getTelegramAdminName(ctx: Context): string {
  const from = ctx.callbackQuery?.from;
  if (!from) return "未知";
  if (from.first_name && from.last_name) {
    return `${from.first_name} ${from.last_name}`;
  }
  if (from.first_name) {
    return from.first_name;
  }
  if (from.username) {
    return `@${from.username}`;
  }
  return `用户 ${from.id}`;
}

function getDiscordAdminName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member && "displayName" in member) {
    return member.displayName;
  }
  return interaction.user.username;
}

export function setTelegramBot(bot: any): void {
  telegramBotInstance = bot;
}

export function setDiscordClient(client: Client): void {
  discordClientInstance = client;
}

function getGroupTargetTags(group: GroupConfig): { tag: string; telegram: boolean }[] {
  const tags: { tag: string; telegram: boolean }[] = [];

  if (group.telegram?.targets) {
    for (const tag of Object.keys(group.telegram.targets)) {
      tags.push({ tag, telegram: true });
    }
  }

  if (group.discord?.r14ChannelId || group.onebot?.r14GroupId) {
    if (!tags.find((t) => t.tag === "r14")) {
      tags.push({ tag: "r14", telegram: false });
    }
  }

  return tags;
}

function withTimeoutResult<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  results: TargetResult[],
  tweetUrl?: string,
): Promise<void> {
  const urlSuffix = tweetUrl ? ` (${tweetUrl})` : "";

  return Promise.race([
    promise.then((val) => {
      const success = typeof val === "boolean" ? val : !!val;
      results.push({ label, success, error: success ? undefined : "返回值为空" });
      logger.info("发送", `[发送] ${label}: ${success ? "成功" : "失败"}`);
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        results.push({ label, success: false, error: `超时 (${ms}ms)` });
        logger.warn("发送", `[发送] ${label}: 超时 (${ms}ms)${urlSuffix}`);
        resolve();
      }, ms);
      timer.unref();
    }),
  ]).catch((err) => {
    results.push({ label, success: false, error: (err as Error).message });
    logger.error("发送", `[发送] ${label}: 错误 - ${(err as Error).message}${urlSuffix}`);
  });
}

async function dispatchGroupDirect(
  tweet: ProcessedTweet,
  group: GroupConfig,
  imageBuffer: Buffer | null,
): Promise<void> {
  const config = getConfig();
  const imageBuf = imageBuffer || getCachedImage(tweet.id) || undefined;
  const promises: Promise<void>[] = [];
  const results: TargetResult[] = [];

  const sendable = await executeBeforeSendHook(tweet, group);
  if (sendable === null) {
    logger.info("审批", `[直发] 插件跳过群组 ${group.name}: onBeforeTweetSend 返回 null`);
    return;
  }
  tweet = sendable;

  if (group.telegram && config.telegram.enabled && telegramBotInstance) {
    promises.push(
      withTimeoutResult(
        sendToTelegram(tweet, group.telegram.chatId, true, imageBuf).then(Boolean),
        90000,
        `${group.name}/Telegram/main`,
        results,
        tweet.url,
      ),
    );
    for (const [tag, target] of Object.entries(group.telegram.targets || {})) {
      promises.push(
        withTimeoutResult(
          sendToTelegram(tweet, target.chatId, true, imageBuf).then(Boolean),
          90000,
          `${group.name}/Telegram/${tag}`,
          results,
          tweet.url,
        ),
      );
    }
  }

  if (group.discord && config.discord.enabled) {
    if (discordClientInstance) {
      promises.push(
        withTimeoutResult(
          sendToDiscord(tweet, group.discord.channelId, true, imageBuf).then((m) => !!m),
          90000,
          `${group.name}/Discord`,
          results,
          tweet.url,
        ),
      );
    } else {
      logger.error("审批", `[直发] 群组 ${group.name}: Discord 客户端未就绪, 跳过发送`);
    }
  }

  if (group.onebot && config.onebot.enabled && isOneBotConnected()) {
    promises.push(
      withTimeoutResult(
        sendToOneBot(tweet, group.onebot.groupId, true, imageBuf).then((m) => m !== null),
        90000,
        `${group.name}/OneBot`,
        results,
        tweet.url,
      ),
    );
  }

  await Promise.allSettled(promises);

  if (results.some((r) => r.success)) {
    markAsSent(tweet.id, tweet.author, tweet.content, tweet.url);
  }

  for (const r of results) {
    if (!r.success) {
      logger.error("审批", `[死信] [直发]: 推文=${tweet.id} 目标=${r.label} 错误=${r.error || "未知"}`);
      storeDeadLetter(tweet.id, r.label, group.name, r.error || "未知");
    }
    await executeHook("onAfterTweetSend", tweet, group, { target: r.label, success: r.success, error: r.error });
  }
}

export async function sendForApproval(tweet: ProcessedTweet): Promise<boolean> {
  const config = getConfig();
  const groups = getEffectiveGroups();

  const useImage = !!config.xToImageApiUrl;
  let imageBuffer: Buffer | null = null;

  const cached = getCachedImage(tweet.id);
  if (cached) {
    imageBuffer = cached;
  } else if (useImage) {
    imageBuffer = await renderTweetImage(tweet);
    if (imageBuffer) {
      cacheImage(tweet.id, imageBuffer);
    }
  }

  let anySent = false;

  for (const group of groups) {
    if (group.blockedUsers?.includes(tweet.author)) {
      logger.info("审批", `[审批] 跳过群组 ${group.name}: 已屏蔽用户 @${tweet.author}`);
      continue;
    }

    if (
      group.users &&
      group.users.length > 0 &&
      !group.users.some((u) => u.username === tweet.author) &&
      !tweet._skipUserFilter
    ) {
      continue;
    }

    const approvalModified = await executeBeforeApprovalHook(tweet, group);
    if (approvalModified === null) {
      logger.info("审批", `[审批] 插件跳过群组 ${group.name}: onBeforeApproval 返回 null`);
      continue;
    }

    if (hasPendingApprovalForTweet(tweet.id, group.name)) {
      logger.info("审批", `[审批] 跳过重复审批: 推文 ${tweet.id} 已有待审批记录 (群组: ${group.name})`);
      continue;
    }

    const approvalId = `${group.name}:${tweet.id}_${Date.now()}`;
    const telegramMessageIds = new Map<string, number>();
    const discordMessageIds = new Map<string, string>();
    const onebotMessageIds = new Map<string, number>();
    let sentToTelegram = false;
    let sentToDiscord = false;
    let sentToOneBot = false;

    if (config.telegram.enabled && group.approval?.telegramAdminChatIds?.length) {
      const tags = getGroupTargetTags(group);
      const buttons: any[][] = [];

      if (tags.length > 0) {
        const row: any[] = [];
        row.push(Markup.button.callback("📢 全部发送", `approve_${approvalId}`));
        for (const t of tags) {
          const label = t.tag === "r14" ? "🔞 Post R14" : `📢 Post ${t.tag.toUpperCase()}`;
          row.push(Markup.button.callback(label, `post_${t.tag}|${approvalId}`));
        }
        row.push(Markup.button.callback("❌ 拒绝", `reject_${approvalId}`));
        buttons.push(row);
      } else {
        buttons.push([
          Markup.button.callback("📢 发送", `approve_${approvalId}`),
          Markup.button.callback("❌ 拒绝", `reject_${approvalId}`),
        ]);
      }

      const keyboard = Markup.inlineKeyboard(buttons);

      const hasExplicitGroups = !!(config.groups && config.groups.length > 0);

      const header = hasExplicitGroups
        ? `📮 <b>待审批推文</b>\n<b>群组:</b> ${escapeHTML(group.name)}\n\n`
        : "📮 <b>待审批推文</b>\n\n";

      const adminMessage =
        useImage && imageBuffer
          ? `${header}<b>@${escapeHTML(tweet.author)}</b>\n<a href="${tweet.url}">🔗 在 X 上查看</a>\n\n<i>ID: ${approvalId}</i>`
          : `${header}${formatTweetHTML(tweet)}\n\n<i>ID: ${approvalId}</i>`;

      if (telegramBotInstance) {
        for (const adminId of group.approval.telegramAdminChatIds) {
          try {
            if (useImage && imageBuffer) {
              const sentMessage = (await retryWithDelay(() =>
                telegramBotInstance.telegram.sendPhoto(
                  adminId,
                  { source: imageBuffer! },
                  {
                    caption: adminMessage.substring(0, 1024),
                    parse_mode: "HTML",
                    ...keyboard,
                  },
                ),
              )) as any;
              telegramMessageIds.set(adminId, sentMessage.message_id);
            } else {
              const sentMessage = (await retryWithDelay(() =>
                telegramBotInstance.telegram.sendMessage(adminId, adminMessage, {
                  parse_mode: "HTML",
                  ...keyboard,
                }),
              )) as any;
              telegramMessageIds.set(adminId, sentMessage.message_id);
            }
            sentToTelegram = true;
          } catch (error) {
            logger.error("审批", `[审批] 向 Telegram 管理员 ${adminId} 发送审批消息失败, 群组:${group.name}:`, error);
          }
        }
      }
    }

    if (config.discord.enabled && group.discord && group.approval?.discordAdminChannelId) {
      if (!discordClientInstance) {
        logger.error("审批", `[审批] 群组 ${group.name}: Discord 客户端未就绪, 审批通知无法发送`);
      } else {
        try {
          const channel = await discordClientInstance.channels.fetch(group.approval.discordAdminChannelId);
          if (channel && channel.isTextBased()) {
            const hasExplicitGroups = !!(config.groups && config.groups.length > 0);

            const title = hasExplicitGroups ? `📮 待审批 — ${escapeHTML(group.name)}` : "📮 待审批";

            const embed = new EmbedBuilder()
              .setTitle(title)
              .setAuthor({
                name: `@${tweet.author}`,
                url: `https://x.com/${tweet.author}`,
                iconURL: `https://unavatar.io/twitter/${tweet.author}`,
              })
              .setURL(tweet.url)
              .setTimestamp(new Date(tweet.publishedAt))
              .setColor("#FFA500")
              .setFooter({ text: `ID: ${approvalId}` });

            if (useImage && imageBuffer) {
              embed.setDescription(`[🔗 在 X 上查看](${tweet.url})`);
            } else {
              embed.setDescription(formatContentForPlatform(tweet.content.substring(0, 2000), "discord"));
            }

            const tags = getGroupTargetTags(group);
            const rows: ActionRowBuilder<ButtonBuilder>[] = [];

            if (tags.length > 0) {
              const postRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`approve_${approvalId}`)
                  .setLabel("📢 全部发送")
                  .setStyle(ButtonStyle.Success),
              );
              for (const t of tags) {
                const label = t.tag === "r14" ? "🔞 发送 R14" : `📢 发送 ${t.tag.toUpperCase()}`;
                postRow.addComponents(
                  new ButtonBuilder()
                    .setCustomId(`post_${t.tag}|${approvalId}`)
                    .setLabel(label)
                    .setStyle(ButtonStyle.Primary),
                );
              }
              postRow.addComponents(
                new ButtonBuilder()
                  .setCustomId(`reject_${approvalId}`)
                  .setLabel("❌ 拒绝")
                  .setStyle(ButtonStyle.Danger),
              );
              rows.push(postRow);
            } else {
              rows.push(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`approve_${approvalId}`)
                    .setLabel("📢 发送")
                    .setStyle(ButtonStyle.Success),
                  new ButtonBuilder()
                    .setCustomId(`reject_${approvalId}`)
                    .setLabel("❌ 拒绝")
                    .setStyle(ButtonStyle.Danger),
                ),
              );
            }

            let files: AttachmentBuilder[] | undefined;

            if (useImage && imageBuffer) {
              const attachment = new AttachmentBuilder(imageBuffer, { name: `tweet_${tweet.id}.png` });
              embed.setImage(`attachment://tweet_${tweet.id}.png`);
              files = [attachment];
            }

            const sentMessage = await (channel as TextChannel).send({
              embeds: [embed],
              components: rows,
              files,
            });

            discordMessageIds.set(group.approval.discordAdminChannelId, sentMessage.id);
            sentToDiscord = true;
          }
        } catch (error) {
          logger.error("审批", `[审批] 向 Discord 群组 ${group.name} 发送审批消息失败:`, error);
        }
      }
    }

    if (config.onebot.enabled && group.approval?.onebotAdminGroupIds?.length && isOneBotConnected()) {
      for (const groupId of group.approval.onebotAdminGroupIds) {
        try {
          const text = `📮 待审批推文\n\n@${tweet.author}\n${tweet.url}\n\nID: ${approvalId}\n\n回复 /approve ${approvalId} 批准\n回复 /reject ${approvalId} 拒绝`;
          const msgId = await sendTextToOneBot(text, groupId);
          if (msgId) {
            onebotMessageIds.set(String(groupId), msgId);
            sentToOneBot = true;
          }
        } catch (error) {
          logger.error("审批", `[审批] 向 OneBot 群组 ${groupId} 发送审批消息失败:`, error);
        }
      }
    }

    if (sentToTelegram || sentToDiscord || sentToOneBot) {
      anySent = true;

      const tweetJson = JSON.stringify(tweet);
      if (!tweetJson) {
        logger.error("审批", `[审批] 推文 ${tweet.id} JSON 序列化失败, 跳过存储`);
        continue;
      }

      storePendingApproval({
        approvalId,
        groupName: group.name,
        tweetId: tweet.id,
        tweetJson,
        telegramMsgIds: Object.fromEntries(telegramMessageIds),
        discordMsgIds: Object.fromEntries(discordMessageIds),
        onebotMsgIds: Object.fromEntries(onebotMessageIds),
        createdAt: new Date(),
        approved: false,
        hasImage: useImage && imageBuffer !== null,
      });

      logger.info("审批", `[审批] 推文 ${tweet.id} 已发送审批请求 (群组: ${group.name}): ${approvalId}`);
    }

    if (!sentToTelegram && !sentToDiscord && !sentToOneBot) {
      const hasApprovalConfig = !!(
        group.approval?.telegramAdminChatIds?.length || group.approval?.discordAdminChannelId
      );
      if (hasApprovalConfig) {
        logger.error("审批", `[审批] 群组 ${group.name}: 审批通知发送失败, 跳过此推文`);
        continue;
      }
      anySent = true;
      logger.info("审批", `[直发] 群组 ${group.name} 无审批配置, 直接发送`);
      await dispatchGroupDirect(tweet, group, imageBuffer);
    }
  }

  return anySent;
}

async function notifyOtherAdmins(
  approval: PendingApproval,
  actionBy: string,
  action: "approved" | "rejected",
  sentTo?: string,
): Promise<void> {
  const statusEmoji = action === "approved" ? "✅" : "❌";
  const statusText = action === "approved" ? "已批准" : "已拒绝";
  const sentToStr = sentTo ? ` → ${sentTo}` : "";
  const cfg = getConfig();
  const hasExplicitGroups = !!(cfg.groups && cfg.groups.length > 0);
  const groupLabel = hasExplicitGroups ? ` (${escapeHTML(approval.groupName)})` : "";

  if (approval.telegramMessageIds.size > 0) {
    const tweet = approval.tweet;
    const notification = [
      `${statusEmoji} <b>推文 ${statusText}${sentToStr}${groupLabel}</b>`,
      "",
      `<b>@${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`,
      `<a href="${tweet.url}">🔗 在 X 上查看</a>`,
      "",
      `操作人: ${escapeHTML(actionBy)}`,
      `ID: <code>${approval.id}</code>`,
      `时间: ${approval.createdAt.toLocaleString()}`,
      "",
      `<i>${formatContentForPlatform(tweet.content.substring(0, 100), "html")}${tweet.content.length > 100 ? "..." : ""}</i>`,
    ].join("\n");

    const showRecallButton = action === "approved";
    const replyMarkup = showRecallButton
      ? {
          reply_markup: Markup.inlineKeyboard([Markup.button.callback("↩️ 撤回", `recall_${approval.id}`)])
            .reply_markup,
        }
      : {};

    for (const [adminId, messageId] of approval.telegramMessageIds) {
      try {
        if (approval.hasImage) {
          await telegramBotInstance?.telegram.editMessageCaption(adminId, messageId, undefined, notification, {
            parse_mode: "HTML",
            ...replyMarkup,
          });
        } else {
          await telegramBotInstance?.telegram.editMessageText(adminId, messageId, undefined, notification, {
            parse_mode: "HTML",
            ...replyMarkup,
          });
        }
      } catch (error) {
        logger.warn("审批", `[通知] 向 Telegram 管理员 ${adminId} 更新审批状态失败:`, error);
      }
    }
  }

  if (approval.discordMessageIds.size > 0 && discordClientInstance) {
    const tweet = approval.tweet;
    const embed = new EmbedBuilder()
      .setTitle(`${statusEmoji} 推文 ${statusText}${sentToStr}${groupLabel}`)
      .setAuthor({
        name: `@${tweet.author}`,
        url: `https://x.com/${tweet.author}`,
        iconURL: `https://unavatar.io/twitter/${tweet.author}`,
      })
      .setURL(tweet.url)
      .addFields(
        { name: "操作人", value: actionBy, inline: true },
        { name: "ID", value: `\`${approval.id}\``, inline: true },
        { name: "时间", value: approval.createdAt.toLocaleString(), inline: true },
      )
      .setColor(action === "approved" ? "#00FF00" : "#FF0000");

    if (approval.hasImage) {
      embed.setImage(`attachment://tweet_${tweet.id}.png`);
    } else {
      embed.setDescription(
        formatContentForPlatform(tweet.content.substring(0, 100), "discord") +
          (tweet.content.length > 100 ? "..." : ""),
      );
    }

    const showRecallButton = action === "approved";
    const components: ActionRowBuilder<ButtonBuilder>[] = showRecallButton
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`recall_${approval.id}`).setLabel("↩ 撤回").setStyle(ButtonStyle.Danger),
          ),
        ]
      : [];

    for (const [channelId, messageId] of approval.discordMessageIds) {
      try {
        const channel = await discordClientInstance.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const message = await (channel as TextChannel).messages.fetch(messageId);
          await message.edit({ embeds: [embed], components });
        }
      } catch (error) {
        logger.warn("审批", `[通知] 向 Discord 频道 ${channelId} 更新审批状态失败:`, error);
      }
    }
  }

  if (approval.onebotMessageIds.size > 0 && isOneBotConnected()) {
    const tweet = approval.tweet;
    const notification = [
      `${statusEmoji} 推文 ${statusText}${sentToStr}${groupLabel}`,
      "",
      `@${tweet.author}`,
      tweet.url,
      "",
      `操作人: ${actionBy}`,
      `ID: ${approval.id}`,
      `时间: ${approval.createdAt.toLocaleString()}`,
      "",
      tweet.content.substring(0, 100) + (tweet.content.length > 100 ? "..." : ""),
    ].join("\n");

    for (const [groupId, messageId] of approval.onebotMessageIds) {
      try {
        await deleteOneBotMessage(messageId, parseInt(groupId));
        await sendTextToOneBot(notification, parseInt(groupId));
      } catch (error) {
        logger.warn("审批", `[通知] 向 OneBot 群组 ${groupId} 更新审批状态失败:`, error);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<void> {
  return Promise.race([
    promise.then(() => {
      logger.info("发送", `[发送] ${label}: 成功`);
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn("发送", `[发送] ${label}: 超时 (${ms}ms)`);
        resolve();
      }, ms);
      timer.unref();
    }),
  ]).catch((err) => {
    logger.error("发送", `[发送] ${label}: 错误 - ${(err as Error).message}`);
  });
}

async function dispatchToTargets(pending: PendingApproval, targetTag?: string): Promise<SendResults> {
  const config = getConfig();
  const groups = getEffectiveGroups();
  const group = groups.find((g) => g.name === pending.groupName);
  const imageBuf = getCachedImage(pending.tweet.id) || undefined;

  if (!group) {
    logger.error("审批", `[调度] 未找到群组 ${pending.groupName}, 审批ID: ${pending.id}`);
    return { total: 0, succeeded: 0, failed: 0, targets: [] };
  }

  const sendable = await executeBeforeSendHook(pending.tweet, group);
  if (sendable === null) {
    logger.info("审批", `[调度] 插件跳过: onBeforeTweetSend 返回 null`);
    return { total: 0, succeeded: 0, failed: 0, targets: [] };
  }
  pending.tweet = sendable;

  const promises: Promise<void>[] = [];
  const results: TargetResult[] = [];

  if (targetTag === "r14" && (group.discord?.r14ChannelId || group.onebot?.r14GroupId)) {
    if (group.discord?.r14ChannelId) {
      if (!discordClientInstance) {
        results.push({ label: "Discord/R14", success: false, error: "Discord 客户端未连接" });
      } else {
        pending.sentTo = "R14 (Discord)";
        promises.push(
          withTimeoutResult(
            sendToDiscord(pending.tweet, group.discord.r14ChannelId, true, imageBuf, pending.id).then((m) => !!m),
            90000,
            `${pending.groupName}/Discord/R14`,
            results,
            pending.tweet.url,
          ),
        );
      }
    }
    if (group.onebot?.r14GroupId) {
      if (!isOneBotConnected()) {
        results.push({ label: "OneBot/R14", success: false, error: "OneBot 未连接" });
      } else {
        pending.sentTo = pending.sentTo || "R14 (OneBot)";
        promises.push(
          withTimeoutResult(
            sendToOneBot(pending.tweet, group.onebot.r14GroupId, true, imageBuf, pending.id).then((m) => m !== null),
            90000,
            `${pending.groupName}/OneBot/R14`,
            results,
            pending.tweet.url,
          ),
        );
      }
    }
  } else if (targetTag && group.telegram?.targets?.[targetTag]) {
    if (!telegramBotInstance) {
      results.push({ label: `Telegram/${targetTag}`, success: false, error: "Telegram bot 未连接" });
      return { total: 1, succeeded: 0, failed: 1, targets: results };
    }
    const targetChatId = group.telegram.targets[targetTag].chatId;
    pending.sentTo = `${targetTag.toUpperCase()}`;
    promises.push(
      withTimeoutResult(
        sendToTelegram(pending.tweet, targetChatId, true, imageBuf, pending.id).then(Boolean),
        90000,
        `${pending.groupName}/Telegram/${targetTag}`,
        results,
        pending.tweet.url,
      ),
    );
  } else {
    if (targetTag) {
      logger.warn("审批", `[调度] 未知目标标签 ${targetTag}, 群组: ${pending.groupName}, 回退到全量发送`);
    }

    pending.sentTo = "All";

    if (group.telegram && config.telegram.enabled) {
      if (telegramBotInstance) {
        promises.push(
          withTimeoutResult(
            sendToTelegram(pending.tweet, group.telegram.chatId, true, imageBuf, pending.id).then(Boolean),
            90000,
            `${pending.groupName}/Telegram/main`,
            results,
            pending.tweet.url,
          ),
        );
      } else {
        results.push({ label: "Telegram/main", success: false, error: "Telegram bot 未连接" });
      }
    }

    for (const [tag, target] of Object.entries(group.telegram?.targets || {})) {
      if (telegramBotInstance) {
        promises.push(
          withTimeoutResult(
            sendToTelegram(pending.tweet, target.chatId, true, imageBuf, pending.id).then(Boolean),
            90000,
            `${pending.groupName}/Telegram/${tag}`,
            results,
            pending.tweet.url,
          ),
        );
      } else {
        results.push({ label: `Telegram/${tag}`, success: false, error: "Telegram bot 未连接" });
      }
    }

    if (group.discord && config.discord.enabled) {
      if (discordClientInstance) {
        promises.push(
          withTimeoutResult(
            sendToDiscord(pending.tweet, group.discord.channelId, true, imageBuf, pending.id).then((m) => !!m),
            90000,
            `${pending.groupName}/Discord`,
            results,
            pending.tweet.url,
          ),
        );
      } else {
        results.push({ label: "Discord", success: false, error: "Discord 客户端未连接" });
      }
    }

    if (group.onebot && config.onebot.enabled && isOneBotConnected()) {
      promises.push(
        withTimeoutResult(
          sendToOneBot(pending.tweet, group.onebot.groupId, true, imageBuf, pending.id).then((m) => m !== null),
          90000,
          `${pending.groupName}/OneBot`,
          results,
          pending.tweet.url,
        ),
      );
    }
  }

  await Promise.allSettled(promises);

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  if (succeeded > 0) {
    markAsSent(pending.tweet.id, pending.tweet.author, pending.tweet.content, pending.tweet.url);
  }

  for (const r of results) {
    if (!r.success) {
      logger.error(
        "审批",
        `[死信] [审批=${pending.id}]: 推文=${pending.tweet.id} 目标=${r.label} 错误=${r.error || "未知"}`,
      );
      storeDeadLetter(pending.tweet.id, r.label, pending.groupName, r.error || "未知");
    }
    await executeHook("onAfterTweetSend", pending.tweet, group, {
      target: r.label,
      success: r.success,
      error: r.error,
    });
  }

  if (failed > 0) {
    logger.error(
      "审批",
      `[调度] 审批 ${pending.id}: ${succeeded}/${promises.length + results.filter((r) => !r.success && !promises.length).length} 成功, ${failed} 失败`,
    );
  }

  return { total: results.length, succeeded, failed, targets: results };
}

export async function handleTelegramApproval(ctx: Context): Promise<void> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery || !("data" in callbackQuery)) return;

  const data = callbackQuery.data;

  const sendMatch = data.match(/^post_(.+)\|(.+)$/);
  const isApprove = data.startsWith("approve_");
  const isReject = data.startsWith("reject_");
  const isSendTag = !!sendMatch;

  if (!isApprove && !isReject && !isSendTag) return;

  let approvalId: string;
  let targetTag: string | undefined;

  if (isSendTag) {
    targetTag = sendMatch![1];
    approvalId = sendMatch![2];
  } else {
    approvalId = data.replace(/^(approve_|reject_)/, "");
  }

  const pending = loadApproval(approvalId);

  if (!pending) {
    try {
      await ctx.answerCbQuery("审批记录未找到或已过期");
    } catch (e) {
      // ignore
    }
    return;
  }

  if (pending.approved) {
    try {
      await ctx.answerCbQuery("这条推文已经被审批过了");
    } catch (e) {
      // ignore
    }
    return;
  }

  const config = getConfig();
  const adminName = getTelegramAdminName(ctx);

  if (!isReject) {
    // 原子性认领, 防止连续点击导致同一推文被发送多次
    if (!claimApproval(pending.id)) {
      try {
        await ctx.answerCbQuery("这条推文已经被审批过了");
      } catch (e) {
        // ignore
      }
      return;
    }

    const results = await dispatchToTargets(pending, targetTag);

    markApprovalDone(pending.id, adminName, pending.sentTo);
    await notifyOtherAdmins(pending, adminName, "approved", pending.sentTo);
    await executeHook(
      "onApprovalResult",
      pending.tweet,
      { name: pending.groupName } as GroupConfig,
      true,
      adminName,
      targetTag,
    );
    logger.info(
      "审批",
      `[审批] ${adminName} 已批准 (Telegram) [${pending.groupName}]: ${approvalId}${targetTag ? ` → ${targetTag}` : ""} — ${results.succeeded}/${results.total} 发送成功`,
    );
  } else {
    await notifyOtherAdmins(pending, adminName, "rejected");
    await executeHook(
      "onApprovalResult",
      pending.tweet,
      { name: pending.groupName } as GroupConfig,
      false,
      adminName,
      targetTag,
    );
    logger.info("审批", `[审批] ${adminName} 已拒绝 (Telegram) [${pending.groupName}]: ${approvalId}`);
    deletePendingApproval(approvalId);
  }
}

export async function handleDiscordApproval(interaction: ButtonInteraction): Promise<void> {
  try {
    await handleDiscordApprovalImpl(interaction);
  } catch (err) {
    logger.error("审批", "Discord 审批处理错误:", err);
  }
}

async function handleDiscordApprovalImpl(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;

  // 不响应非本 bot 配置的审批频道
  if (!isConfiguredAdminChannel(interaction.channelId)) return;

  // 尝试确认交互，Bun 运行时下 interaction 可能已被自动确认
  try {
    await interaction.deferUpdate();
  } catch {}

  const sendMatch = customId.match(/^post_(.+)\|(.+)$/);
  const isApprove = customId.startsWith("approve_");
  const isReject = customId.startsWith("reject_");
  const isSendTag = !!sendMatch;

  if (!isApprove && !isReject && !isSendTag) return;

  let approvalId: string;
  let targetTag: string | undefined;

  if (isSendTag) {
    targetTag = sendMatch![1];
    approvalId = sendMatch![2];
  } else {
    approvalId = customId.replace(/^(approve_|reject_)/, "");
  }

  const pending = loadApproval(approvalId);

  if (!pending) {
    getConfig().debugMode && logger.warn("审批", `[审批] Discord approve 记录未找到: ${approvalId}`);
    try {
      await interaction.message.edit({ content: "⚠️ 审批记录未找到或已过期", components: [] });
    } catch {}
    return;
  }
  getConfig().debugMode &&
    logger.info("审批", `[审批] Discord approve 记录已找到: ${approvalId}, approved=${pending.approved}`);

  if (pending.approved) {
    getConfig().debugMode && logger.warn("审批", `[审批] Discord approve 已处理过: ${approvalId}`);
    try {
      await interaction.message.edit({ content: "⚠️ 这条推文已经被审批过了", components: [] });
    } catch {}
    return;
  }
  getConfig().debugMode && logger.info("审批", `[审批] Discord approve 继续执行: ${approvalId}`);

  const config = getConfig();
  const group = getEffectiveGroups().find((g) => g.name === pending.groupName);

  if (group?.approval?.discordApproveRoleId) {
    const member = interaction.member;
    if (!member || !("roles" in member) || !(member.roles as any).cache?.has(group.approval.discordApproveRoleId)) {
      try {
        await interaction.followUp({ content: "❌ 你没有审批权限", flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }
  } else if (config.discord.approveRoleId) {
    const member = interaction.member;
    if (!member || !("roles" in member) || !(member.roles as any).cache?.has(config.discord.approveRoleId)) {
      try {
        await interaction.followUp({ content: "❌ 你没有审批权限", flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }
  }

  const adminName = getDiscordAdminName(interaction);

  if (!isReject) {
    // 原子性认领, 防止连续点击导致同一推文被发送多次
    if (!claimApproval(pending.id)) {
      getConfig().debugMode && logger.warn("审批", `[审批] Discord approve 已被其他处理者认领: ${approvalId}`);
      try {
        await interaction.message.edit({ content: "⚠️ 这条推文已经被审批过了", components: [] });
      } catch {}
      return;
    }

    const results = await dispatchToTargets(pending, targetTag);

    markApprovalDone(pending.id, adminName, pending.sentTo);
    await notifyOtherAdmins(pending, adminName, "approved", pending.sentTo);
    await executeHook(
      "onApprovalResult",
      pending.tweet,
      { name: pending.groupName } as GroupConfig,
      true,
      adminName,
      targetTag,
    );
    logger.info(
      "审批",
      `[审批] ${adminName} 已批准 (Discord) [${pending.groupName}]: ${approvalId}${targetTag ? ` → ${targetTag}` : ""} — ${results.succeeded}/${results.total} 发送成功`,
    );
  } else {
    await notifyOtherAdmins(pending, adminName, "rejected");
    await executeHook(
      "onApprovalResult",
      pending.tweet,
      { name: pending.groupName } as GroupConfig,
      false,
      adminName,
      targetTag,
    );
    logger.info("审批", `[审批] ${adminName} 已拒绝 (Discord) [${pending.groupName}]: ${approvalId}`);
    deletePendingApproval(approvalId);
  }
}

export function getPendingCount(): number {
  return getAllPendingApprovals().length;
}

function checkRecallPermission(
  interaction: ButtonInteraction | ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
): boolean {
  const config = getConfig();
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;

  const approveRoleIds = new Set<string>();
  const groups = getEffectiveGroups();
  for (const g of groups) {
    if (g.approval?.discordApproveRoleId) {
      approveRoleIds.add(g.approval.discordApproveRoleId);
    }
  }
  if (config.discord.approveRoleId) {
    approveRoleIds.add(config.discord.approveRoleId);
  }

  if (approveRoleIds.size === 0) return true;

  const roles = (member as any).roles;
  if (roles.cache) {
    for (const id of approveRoleIds) {
      if (roles.cache.has(id)) return true;
    }
    return false;
  }

  if (Array.isArray(roles)) {
    return roles.some((r: string) => approveRoleIds.has(r));
  }

  return false;
}

export async function handleRecallCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!checkRecallPermission(interaction)) {
      await interaction.reply({ content: "❌ 你没有撤回权限", flags: MessageFlags.Ephemeral });
      return;
    }

    const messageId = interaction.options.get("message_id")?.value as string | undefined;
    const link = interaction.options.get("link")?.value as string | undefined;

    if (messageId) {
      const deleted = await recallMessageById(messageId);
      await interaction.reply({
        content: deleted ? `已撤回消息 ${messageId}` : `未找到消息 ${messageId}，或该消息不是 bot 发送的`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (link) {
      const match = link.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
      if (!match) {
        await interaction.reply({ content: "无效的消息链接", flags: MessageFlags.Ephemeral });
        return;
      }
      const linkMsgId = match[2];
      const deleted = await recallMessageById(linkMsgId);
      await interaction.reply({
        content: deleted ? `已撤回消息 ${linkMsgId}` : `未找到消息 ${linkMsgId}，或该消息不是 bot 发送的`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const count = (interaction.options.get("count")?.value as number) || 5;
    const deleted = await recallMessages(interaction.channelId, Math.min(count, 20));
    await interaction.reply({
      content: `已尝试撤回最近 ${count} 条消息，成功撤回 ${deleted} 条`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error("审批", "撤回命令错误:", error);
    try {
      await interaction.reply({ content: "撤回失败: 内部错误", flags: MessageFlags.Ephemeral });
    } catch {}
  }
}

export async function handleRecallMessageContextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  try {
    if (!checkRecallPermission(interaction)) {
      await interaction.reply({ content: "❌ 你没有撤回权限", flags: MessageFlags.Ephemeral });
      return;
    }

    const target = interaction.targetMessage;
    if (target.author.id !== interaction.client.user.id) {
      await interaction.reply({ content: "该消息不是 bot 发送的，无法撤回", flags: MessageFlags.Ephemeral });
      return;
    }

    await target.delete();
    deleteSentMessage(target.id);
    await interaction.reply({ content: "已撤回该消息", flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error("审批", "撤回上下文菜单错误:", error);
    try {
      await interaction.reply({ content: "撤回失败: 内部错误", flags: MessageFlags.Ephemeral });
    } catch {}
  }
}

async function recallDispatchedMessages(approvalId: string): Promise<number> {
  const deleted = await (async () => {
    const pending = loadApproval(approvalId);
    if (!pending) return 0;

    const groups = getEffectiveGroups();
    const group = groups.find((g) => g.name === pending.groupName);

    const discordChannelIds = new Set<string>();
    const telegramChatIds = new Set<string>();
    const onebotGroupIds = new Set<number>();

    if (group) {
      if (group.discord?.channelId) discordChannelIds.add(group.discord.channelId);
      if (group.discord?.r14ChannelId) discordChannelIds.add(group.discord.r14ChannelId);
      if (group.telegram?.chatId) telegramChatIds.add(group.telegram.chatId);
      if (group.telegram?.targets) {
        for (const target of Object.values(group.telegram.targets)) {
          telegramChatIds.add(target.chatId);
        }
      }
      if (group.onebot?.groupId) onebotGroupIds.add(group.onebot.groupId);
      if (group.onebot?.r14GroupId) onebotGroupIds.add(group.onebot.r14GroupId);
    }

    const tweetId = pending.tweet.id;
    let count = 0;

    const discordRecords = getSentDiscordMessagesByTweetId(tweetId);
    for (const record of discordRecords) {
      if (!discordChannelIds.has(record.channel_id)) {
        continue;
      }
      try {
        if (discordClientInstance) {
          const channel = await discordClientInstance.channels.fetch(record.channel_id);
          if (channel && channel.isTextBased()) {
            const message = await (channel as TextChannel).messages.fetch(record.message_id);
            await message.delete();
            count++;
          }
        }
        deleteSentMessage(record.message_id);
      } catch (error) {
        deleteSentMessage(record.message_id);
      }
    }

    const tgRecords = getSentTgMessagesByTweetId(tweetId);
    if (telegramBotInstance) {
      for (const record of tgRecords) {
        if (!telegramChatIds.has(record.chat_id)) {
          continue;
        }
        try {
          await telegramBotInstance.telegram.deleteMessage(record.chat_id, record.message_id);
          count++;
          deleteSentTgMessage(record.message_id, record.chat_id);
        } catch (error) {
          deleteSentTgMessage(record.message_id, record.chat_id);
        }
      }
    }

    const obRecords = getSentOneBotMessagesByTweetId(tweetId);
    for (const record of obRecords) {
      if (!onebotGroupIds.has(record.group_id)) {
        continue;
      }
      try {
        await deleteOneBotMessage(record.message_id, record.group_id);
        count++;
        deleteSentOneBotMessage(record.message_id, record.group_id);
      } catch (error) {
        deleteSentOneBotMessage(record.message_id, record.group_id);
      }
    }

    deletePendingApproval(approvalId);
    return count;
  })();
  return deleted;
}

async function notifyRecallAdmins(approval: PendingApproval, adminName: string, deletedCount: number): Promise<void> {
  const cfg = getConfig();
  const hasExplicitGroups = !!(cfg.groups && cfg.groups.length > 0);
  const groupLabel = hasExplicitGroups ? ` (${escapeHTML(approval.groupName)})` : "";

  if (approval.telegramMessageIds.size > 0 && telegramBotInstance) {
    for (const [adminId, messageId] of approval.telegramMessageIds) {
      try {
        const tweet = approval.tweet;
        let notice: string;
        if (approval.hasImage) {
          notice = [
            `↩️ <b>撤回成功 — 已删除 ${deletedCount} 条消息${groupLabel}</b>`,
            "",
            `<b>@${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`,
            `<a href="${tweet.url}">🔗 在 X 上查看</a>`,
            "",
            `操作人: ${escapeHTML(adminName)}`,
            `ID: <code>${approval.id}</code>`,
          ].join("\n");

          await telegramBotInstance.telegram.editMessageCaption(adminId, messageId, undefined, notice, {
            parse_mode: "HTML",
          });
        } else {
          notice = [
            `↩️ <b>撤回成功 — 已删除 ${deletedCount} 条消息${groupLabel}</b>`,
            "",
            `<b>@${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`,
            `<a href="${tweet.url}">🔗 在 X 上查看</a>`,
            "",
            `操作人: ${escapeHTML(adminName)}`,
            `ID: <code>${approval.id}</code>`,
          ].join("\n");

          await telegramBotInstance.telegram.editMessageText(adminId, messageId, undefined, notice, {
            parse_mode: "HTML",
          });
        }
      } catch (error) {
        logger.warn("审批", `[通知] 向 Telegram 管理员 ${adminId} 发送撤回通知失败:`, error);
      }
    }
  }

  if (approval.discordMessageIds.size > 0 && discordClientInstance) {
    const tweet = approval.tweet;
    const embed = new EmbedBuilder()
      .setTitle(`↩️ 撤回成功 — 已删除 ${deletedCount} 条消息${groupLabel}`)
      .setAuthor({
        name: `@${tweet.author}`,
        url: `https://x.com/${tweet.author}`,
        iconURL: `https://unavatar.io/twitter/${tweet.author}`,
      })
      .setURL(tweet.url)
      .addFields({ name: "操作人", value: adminName, inline: true })
      .setColor("#FFA500");

    for (const [channelId, messageId] of approval.discordMessageIds) {
      try {
        const channel = await discordClientInstance.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const message = await (channel as TextChannel).messages.fetch(messageId);
          await message.edit({ embeds: [embed], components: [] });
        }
      } catch (error) {
        logger.warn("审批", `[通知] 向 Discord 频道 ${channelId} 发送撤回通知失败:`, error);
      }
    }
  }
}

export async function handleTelegramRecall(ctx: Context): Promise<void> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery || !("data" in callbackQuery)) return;

  const data = callbackQuery.data;
  if (!data.startsWith("recall_")) return;

  const approvalId = data.replace("recall_", "");
  const pending = loadApproval(approvalId);

  if (!pending) {
    try {
      await ctx.answerCbQuery("审批记录未找到或已过期");
    } catch (e) {}
    return;
  }

  if (!pending.approved) {
    try {
      await ctx.answerCbQuery("该推文尚未被批准");
    } catch (e) {}
    return;
  }

  const adminName = getTelegramAdminName(ctx);
  try {
    await ctx.answerCbQuery("正在撤回...");
  } catch (e) {}

  const deleted = await recallDispatchedMessages(approvalId);
  await notifyRecallAdmins(pending, adminName, deleted);
  logger.info(
    "审批",
    `[撤回] ${adminName} (Telegram) [${pending.groupName}]: ${approvalId} — 已删除 ${deleted} 条消息`,
  );
}

export async function handleDiscordRecall(interaction: ButtonInteraction): Promise<void> {
  try {
    const customId = interaction.customId;
    if (!customId.startsWith("recall_")) return;

    // 不响应非本 bot 配置的审批频道
    if (!isConfiguredAdminChannel(interaction.channelId)) return;

    // Bun 运行时下 interaction 可能已被自动确认
    try {
      await interaction.deferUpdate();
    } catch {}

    const approvalId = customId.replace("recall_", "");
    getConfig().debugMode && logger.info("审批", `[撤回] Discord 开始处理: ${approvalId}`);
    const pending = loadApproval(approvalId);

    if (!pending) {
      getConfig().debugMode && logger.warn("审批", `[撤回] Discord 审批记录未找到: ${approvalId}`);
      try {
        await interaction.followUp({ content: "审批记录未找到或已过期", flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }
    getConfig().debugMode &&
      logger.info("审批", `[撤回] Discord 记录已找到: ${approvalId}, approved=${pending.approved}`);

    if (!pending.approved) {
      getConfig().debugMode && logger.warn("审批", `[撤回] Discord 尚未批准: ${approvalId}`);
      try {
        await interaction.followUp({ content: "该推文尚未被批准", flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }
    getConfig().debugMode && logger.info("审批", `[撤回] Discord 继续执行撤回: ${approvalId}`);

    const adminName = getDiscordAdminName(interaction);
    const deleted = await recallDispatchedMessages(approvalId);
    await notifyRecallAdmins(pending, adminName, deleted);
    logger.info(
      "审批",
      `[撤回] ${adminName} (Discord) [${pending.groupName}]: ${approvalId} — 已删除 ${deleted} 条消息`,
    );
  } catch (error) {
    logger.error("审批", "Discord 撤回处理错误:", error);
  }
}

export function cleanupExpiredApprovals(maxAgeMinutes: number = 60): number {
  const now = Date.now();
  let cleaned = 0;

  const all = getAllPendingApprovals();
  for (const p of all) {
    if (p.approvalId && p.createdAt && (now - p.createdAt) / (1000 * 60) > maxAgeMinutes) {
      deletePendingApproval(p.approvalId);
      cleaned++;
    }
  }

  return cleaned;
}

export async function sendToAllGroups(tweet: ProcessedTweet, targetTag?: string): Promise<void> {
  const config = getConfig();
  const groups = getEffectiveGroups();
  const imageBuf = getCachedImage(tweet.id) || undefined;

  for (const group of groups) {
    if (group.blockedUsers?.includes(tweet.author)) {
      logger.info("审批", `[直发] 跳过群组 ${group.name}: 已屏蔽用户 @${tweet.author}`);
      continue;
    }

    if (
      group.users &&
      group.users.length > 0 &&
      !group.users.some((u) => u.username === tweet.author) &&
      !tweet._skipUserFilter
    ) {
      continue;
    }

    const modified = await executeBeforeSendHook(tweet, group);
    if (modified === null) {
      logger.info("审批", `[直发] 插件跳过群组 ${group.name}: onBeforeTweetSend 返回 null`);
      continue;
    }
    tweet = modified;

    if (targetTag === "r14") {
      if (group.discord?.r14ChannelId && config.discord.enabled) {
        withTimeout(
          sendToDiscord(tweet, group.discord.r14ChannelId, true, imageBuf).then(Boolean),
          90000,
          `${group.name}/Discord/R14`,
        );
      }
      if (group.onebot?.r14GroupId && config.onebot.enabled && isOneBotConnected()) {
        withTimeout(
          sendToOneBot(tweet, group.onebot.r14GroupId, true, imageBuf).then(Boolean),
          90000,
          `${group.name}/OneBot/R14`,
        );
      }
      continue;
    }

    if (targetTag && targetTag !== "r14") {
      if (group.telegram?.targets?.[targetTag] && config.telegram.enabled) {
        withTimeout(
          sendToTelegram(tweet, group.telegram.targets[targetTag].chatId, true, imageBuf).then(Boolean),
          90000,
          `${group.name}/Telegram/${targetTag}`,
        );
      }
      continue;
    }

    if (group.telegram && config.telegram.enabled) {
      withTimeout(
        sendToTelegram(tweet, group.telegram.chatId, true, imageBuf).then(Boolean),
        90000,
        `${group.name}/Telegram/main`,
      );
      for (const [tag, target] of Object.entries(group.telegram.targets || {})) {
        withTimeout(
          sendToTelegram(tweet, target.chatId, true, imageBuf).then(Boolean),
          90000,
          `${group.name}/Telegram/${tag}`,
        );
      }
    }

    if (group.discord && config.discord.enabled) {
      withTimeout(
        sendToDiscord(tweet, group.discord.channelId, true, imageBuf).then(Boolean),
        90000,
        `${group.name}/Discord`,
      );
    }

    if (group.onebot && config.onebot.enabled && isOneBotConnected()) {
      withTimeout(
        sendToOneBot(tweet, group.onebot.groupId, true, imageBuf).then(Boolean),
        90000,
        `${group.name}/OneBot`,
      );
    }
  }
}

export async function handleOneBotApproval(
  approvalId: string,
  userId: number,
  groupId: number,
  reject = false,
): Promise<void> {
  const approval = loadApproval(approvalId);
  if (!approval) {
    logger.warn("审批", `[OneBot] 审批 ${approvalId} 不存在或已处理`);
    await sendTextToOneBot(`❌ 审批 ${approvalId} 不存在或已处理`, groupId);
    return;
  }

  await processApproval(approval, reject, `OneBot用户${userId}`, groupId);
}

async function processApproval(
  approval: PendingApproval,
  reject: boolean,
  actionBy: string,
  groupId?: number,
): Promise<void> {
  if (approval.approved) {
    if (groupId) {
      await sendTextToOneBot(`⚠️ 审批 ${approval.id} 已被处理`, groupId);
    }
    return;
  }

  approval.approved = !reject;
  approval.approvedBy = actionBy;

  if (reject) {
    logger.info("审批", `[审批] 推文 ${approval.tweet.id} 被拒绝 (操作人: ${actionBy})`);
    deletePendingApproval(approval.id);
    await notifyOtherAdmins(approval, actionBy, "rejected");
  } else {
    // 原子性认领, 防止连续操作导致同一推文被发送多次
    if (!claimApproval(approval.id)) {
      logger.warn("审批", `[审批] 推文 ${approval.tweet.id} 已被其他处理者认领, 跳过 (操作人: ${actionBy})`);
      if (groupId) {
        await sendTextToOneBot(`⚠️ 审批 ${approval.id} 已被处理`, groupId);
      }
      return;
    }
    logger.info("审批", `[审批] 推文 ${approval.tweet.id} 已批准 (操作人: ${actionBy})`);
    const results = await dispatchToTargets(approval);
    approval.sentTo =
      results.targets
        .filter((r) => r.success)
        .map((r) => r.label)
        .join(", ") || "无";
    await notifyOtherAdmins(approval, actionBy, "approved", approval.sentTo);
  }
}
