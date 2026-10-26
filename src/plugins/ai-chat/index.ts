import { getDiscordClient } from '@/bots/discord';
import { getConfig } from '@/config';
import { logger } from '@/logger';
import { getDatabase } from '@/storage';
import type { PluginDefinition } from '@/plugins/types';
import { registerAffinityAndMood } from './appraise';
import { isAiEnabled } from './chat';
import { aiCommandDefinitions, handleAiCommand } from './commands';
import { migrateAiSchema } from './db/schema';
import { initDiscordAiChat } from './discord-chat';
import { loadLore, stopWatchingLore, watchLore } from './lore';
import { registerExtraction } from './memory/extract';
import { registerProfiles } from './memory/profile';
import { loadPersonas, stopWatchingPersonas, watchPersonas } from './persona/loader';
import { flushPresenceSessions } from './presence';
import { registerRetention } from './retention';
import { configureSqliteRuntime, initVectors, registerVectorJobs } from './vector/service';
import { startWorker, stopWorker } from './worker';

export default {
  manifest: {
    name: 'ai-chat',
    version: '2.0.0',
    description: 'Discord AI 角色：人设卡、长期记忆、好感度、情绪、主动插话',
    author: 'shit-bot',
  },
  init: () => {
    // macOS 自带的 SQLite 不能加载扩展：配置了自定义 SQLite 时必须在打开数据库之前切换（插件在 initDatabase 之前加载）
    configureSqliteRuntime();
  },
  hooks: {
    onAfterInit: async () => {
      // AI 表走版本化迁移；失败只让记忆类功能不可用，不影响推文转发等核心功能
      migrateAiSchema(getDatabase());
      if (!isAiEnabled()) {
        logger.info('AI', 'AI 聊天未启用，跳过 AI 初始化');
        return;
      }

      // 人设卡与设定集：启动时加载（目录为空会生成默认 memecat 人设卡），之后改动文件自动生效
      const personaCount = loadPersonas();
      watchPersonas();
      const loreCount = loadLore();
      watchLore();
      logger.info('AI', `已加载 ${personaCount} 张人设卡、${loreCount} 条设定集条目`);

      // 后台流水线一律注册，执不执行看运行时配置（任务队列只领取功能开着的任务、调度器自己检查开关），
      // 这样启动时没开记忆、之后在 WebUI 打开也能立刻工作
      registerExtraction();
      registerProfiles();
      registerAffinityAndMood();
      // 向量化（配置了向量模型才启用）：自动选择 sqlite-vec 或 JS 后端，后台回填
      await initVectors();
      registerVectorJobs();
      registerRetention();
      startWorker();

      const client = getDiscordClient();
      if (!getConfig().discord.enabled || !client) return;
      initDiscordAiChat(client);
      client.on('interactionCreate', (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        // 交互 token 过期或瞬时网络错误导致回复失败：只记录，不让它变成未处理的拒绝
        handleAiCommand(interaction).catch((e) => logger.error('AI', `命令 /${interaction.commandName} 出错:`, (e as Error)?.message || e));
      });
    },
    // /memory /forget /callme /pronouns /affinity /shh /optout /optin /forget-me（旧的 /delete-memory 已由 /forget 取代）
    onDiscordCommands: () => (isAiEnabled() ? aiCommandDefinitions() : []),
    onBeforeShutdown: () => {
      stopWorker();
      stopWatchingPersonas();
      stopWatchingLore();
      try {
        flushPresenceSessions();
      } catch {
        // 退出途中数据库可能已不可用，忽略
      }
    },
  },
} satisfies PluginDefinition;
