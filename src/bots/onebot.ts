import WebSocket from "ws";
import { ProcessedTweet, OneBotConfig } from "@/types";
import { getConfig } from "@/config";
import { formatContentForPlatform } from "@/filters";
import { renderTweetImage } from "@/renderer";
import { storeSentOneBotMessage } from "@/storage";
import { getCachedImage } from "@/storage";
import { logger } from "@/logger";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let messageId = 1;
let connected = false;

type MessageHandler = (message: OneBotMessage) => void | Promise<void>;
let messageHandler: MessageHandler | null = null;

export interface OneBotMessage {
  message_id: number;
  group_id?: number;
  user_id: number;
  message: string;
  raw_message?: string;
  sender?: {
    user_id: number;
    nickname?: string;
    card?: string;
  };
}

const pendingActions = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function sendAction(action: string, params: Record<string, any> = {}): Promise<any> {
  const echo = `${messageId++}`;
  return new Promise<any>((resolve, reject) => {
    pendingActions.set(echo, { resolve, reject });
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, params, echo }));
    } else {
      pendingActions.delete(echo);
      reject(new Error("WebSocket 未连接"));
    }
    setTimeout(() => {
      if (pendingActions.has(echo)) {
        pendingActions.delete(echo);
        reject(new Error("请求超时"));
      }
    }, 15000);
  });
}

export async function sendToOneBot(
  tweet: ProcessedTweet,
  groupId: number,
  asImage: boolean = false,
  preRenderedImage?: Buffer | null,
  approvalId?: string,
): Promise<number | null> {
  const config = getConfig();
  const sendImage = asImage || config.sendAsImage;

  let imageBuffer: Buffer | null = preRenderedImage || null;

  if (sendImage && !imageBuffer) {
    imageBuffer = getCachedImage(tweet.id) || (await renderTweetImage(tweet));
  }

  try {
    if (imageBuffer) {
      const base64 = imageBuffer.toString("base64");
      const imageSeg = `[CQ:image,file=base64://${base64}]`;
      const text = formatContentForPlatform(tweet.content, "onebot");
      const footer = approvalId ? `\n\nID: ${approvalId}` : "";
      const msg = `${imageSeg}\n${text}${footer}`;

      const result = await sendAction("send_group_msg", {
        group_id: groupId,
        message: msg,
      });
      if (result?.message_id) {
        storeSentOneBotMessage(groupId, result.message_id, tweet.id);
      }
      return result?.message_id || null;
    } else {
      const text = formatContentForPlatform(tweet.content, "onebot");
      const link = `\n\n🔗 ${tweet.url}`;
      const footer = approvalId ? `\n\nID: ${approvalId}` : "";
      const msg = `${text}${link}${footer}`;

      const result = await sendAction("send_group_msg", {
        group_id: groupId,
        message: msg,
      });
      if (result?.message_id) {
        storeSentOneBotMessage(groupId, result.message_id, tweet.id);
      }
      return result?.message_id || null;
    }
  } catch (error) {
    logger.error("OneBot", `发送到群组 ${groupId} 失败:`, error);
    return null;
  }
}

export async function sendTextToOneBot(text: string, groupId: number): Promise<number | null> {
  try {
    const result = await sendAction("send_group_msg", {
      group_id: groupId,
      message: text,
    });
    return result?.message_id || null;
  } catch (error) {
    logger.error("OneBot", `发送文本到群组 ${groupId} 失败:`, error);
    return null;
  }
}

export async function sendImageToOneBot(
  groupId: number,
  imageBase64: string,
  caption: string = "",
): Promise<number | null> {
  try {
    const imageSeg = `[CQ:image,file=base64://${imageBase64}]`;
    const message = caption ? `${imageSeg}\n${caption}` : imageSeg;
    const result = await sendAction("send_group_msg", {
      group_id: groupId,
      message,
    });
    return result?.message_id || null;
  } catch (error) {
    logger.error("OneBot", `发送图片到群组 ${groupId} 失败:`, error);
    return null;
  }
}

export async function deleteOneBotMessage(messageId: number, groupId: number): Promise<boolean> {
  try {
    await sendAction("delete_msg", { message_id: messageId });
    return true;
  } catch (error) {
    logger.error("OneBot", `撤回消息 ${messageId} 失败:`, error);
    return false;
  }
}

function connect(): void {
  const config = getConfig();
  if (!config.onebot.enabled || !config.onebot.url) return;

  let wsUrl = config.onebot.url.replace(/^http/, "ws");
  if (config.onebot.token) {
    const sep = wsUrl.includes("?") ? "&" : "?";
    wsUrl = `${wsUrl}${sep}access_token=${encodeURIComponent(config.onebot.token)}`;
  }
  logger.info("OneBot", `正在连接 ${wsUrl}`);

  const wsOptions: Record<string, any> = {};
  if (!config.onebot.wsSslVerify) {
    wsOptions.rejectUnauthorized = false;
  }
  ws = new WebSocket(wsUrl, wsOptions);

  ws.on("open", () => {
    connected = true;
    logger.info("OneBot", "WebSocket 已连接");

    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      // 处理 API 响应（OneBot 11 通过 echo 匹配请求）
      if (event.echo && pendingActions.has(event.echo)) {
        const { resolve, reject } = pendingActions.get(event.echo)!;
        pendingActions.delete(event.echo);
        if (event.retcode !== 0) {
          reject(new Error(`OneBot API 错误: ${event.message || event.wording || event.retcode}`));
        } else {
          resolve(event.data);
        }
        return;
      }
      // 处理群消息
      if (event.message_type === "group" && event.raw_message) {
        const msg: OneBotMessage = {
          message_id: event.message_id,
          group_id: event.group_id,
          user_id: event.user_id,
          message: event.message,
          raw_message: event.raw_message,
          sender: event.sender,
        };
        messageHandler?.(msg);
      }
    } catch {}
  });

  ws.on("close", () => {
    connected = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // 清理所有待处理的请求
    for (const [, { reject }] of pendingActions) {
      reject(new Error("WebSocket 已断开"));
    }
    pendingActions.clear();
    logger.info("OneBot", "WebSocket 已断开");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.error("OneBot", "WebSocket 错误:", err.message);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const interval = getConfig().onebot.reconnectInterval || 5000;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, interval);
}

export async function initOneBot(): Promise<boolean> {
  const config = getConfig();
  if (!config.onebot.enabled) {
    logger.info("OneBot", "已在配置中禁用");
    return false;
  }

  if (!config.onebot.url) {
    logger.error("OneBot", "未配置 URL");
    return false;
  }

  connect();
  return true;
}

export function setOneBotMessageHandler(handler: MessageHandler): void {
  messageHandler = handler;
}

export function isOneBotConnected(): boolean {
  return connected;
}

export function getOneBotMessageId(): number {
  return messageId++;
}

export async function shutdownOneBot(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  connected = false;
  logger.info("OneBot", "已断开连接");
}
