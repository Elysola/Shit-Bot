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
          { text: "AI Chat", link: "/plugins/ai-chat" },
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
