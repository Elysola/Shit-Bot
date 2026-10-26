import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { isAiSchemaReady } from '@/plugins/ai-chat/db/schema';

/** Discord 斜杠命令的注册数据（REST 直接提交的 JSON 形态） */
export type SlashCommandData = {
  name: string;
  description: string;
  options?: Array<{
    name: string;
    description: string;
    type: number;
    required?: boolean;
    min_value?: number;
    max_value?: number;
    max_length?: number;
    choices?: Array<{ name: string; value: string | number }>;
  }>;
  default_member_permissions?: string;
  dm_permission?: boolean;
};

type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

const handlers = new Map<string, CommandHandler>();
const definitions: SlashCommandData[] = [];

/** 注册一个 AI 相关的斜杠命令（各功能模块在加载时调用；由 ai/commands.ts 统一引入） */
export function defineAiCommand(data: SlashCommandData, handler: CommandHandler): void {
  if (handlers.has(data.name)) throw new Error(`斜杠命令重复定义: ${data.name}`);
  definitions.push({ dm_permission: false, ...data });
  handlers.set(data.name, handler);
}

export function aiCommandDefinitions(): SlashCommandData[] {
  return [...definitions];
}

/** 处理 AI 斜杠命令；不是 AI 命令时返回 false 交给其它处理器 */
export async function handleAiCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const handler = handlers.get(interaction.commandName);
  if (!handler) return false;
  if (!isAiSchemaReady()) {
    await interaction.reply({ content: 'AI 数据层暂时不可用，请稍后再试。', flags: MessageFlags.Ephemeral });
    return true;
  }
  await handler(interaction);
  return true;
}

export async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const body = content.length > 1900 ? content.slice(0, 1900) + '\n…（过长已截断）' : content;
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content: body });
  else await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
}
