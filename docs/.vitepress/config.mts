import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Shit Bot",
  description: "X/Twitter 推文监控推送 Bot",
  lang: "zh-CN",
  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/getting-started" },
      { text: "配置", link: "/guide/configuration" },
      { text: "插件", link: "/guide/plugins" },
    ],
    sidebar: [
      {
        text: "入门",
        items: [
          { text: "快速开始", link: "/guide/getting-started" },
          { text: "配置说明", link: "/guide/configuration" },
          { text: "部署", link: "/guide/deployment" },
        ],
      },
      {
        text: "插件系统",
        items: [
          { text: "概述", link: "/guide/plugins" },
          {
            text: "AI Chat",
            link: "/plugins/ai-chat/",
            collapsed: false,
            items: [
              { text: "使用教程", link: "/plugins/ai-chat/getting-started" },
              { text: "人设卡与设定集", link: "/plugins/ai-chat/persona-and-lore" },
              { text: "工作原理与算法", link: "/plugins/ai-chat/algorithms" },
              { text: "适用场景与局限", link: "/plugins/ai-chat/use-cases" },
              { text: "升级与数据迁移", link: "/plugins/ai-chat/upgrade-and-migration" },
              { text: "运维、隐私与排错", link: "/plugins/ai-chat/operations" },
            ],
          },
          { text: "JM 每日推荐", link: "/plugins/jm-daily" },
          { text: "开发插件", link: "/guide/plugin-dev" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/Elysola/shit-bot" }],
    editLink: {
      pattern: "https://github.com/Elysola/shit-bot/edit/main/docs/:path",
      text: "在 GitHub 上编辑此页",
    },
  },
});
