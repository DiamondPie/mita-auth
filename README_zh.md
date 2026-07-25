# Mita

**一套开箱即用、框架无关（Framework-agnostic）的鉴权与反爬（Anti-abuse）防护 SDK。**
一次编写核心逻辑，同时适配 Next.js / Nuxt / React / Vue / 原生 JS，供个人主页与后续所有项目复用。

> 状态：🚧 开发中 — `@mita-auth/core`、`@mita-auth/server`、`@mita-auth/client` 与 `@mita-auth/react` 已完成，接下来是 `@mita-auth/vue` 绑定；尚未发布到 npm。

*[English version](./README.md)*

---

## 这是什么

留言板 / 评论区常见的安全防护——人机验证、速率限制、XSS 内容清洗、防重放签名——本质上和 UI 框架无关，却常常在每个新项目里被重新实现一遍。Mita 把这套逻辑抽成一个独立、可审计的开源 SDK：核心只做"粘合层"，绑定社区验证过的成熟依赖，而不是重新发明密码学或限流算法。

## 设计目标

1. **框架无关**：核心逻辑不依赖任何 UI 框架，React / Vue / Svelte / 原生 HTML 均可直接使用。
2. **不重复造轮子**：只做粘合层与开箱即用的默认配置，密码学、网络请求、限流算法全部依赖社区验证过的成熟库。
3. **按需引入**：拆分为多个小包，避免前端项目被迫引入 Node.js 专属依赖。
4. **开源 + 可审计**：MIT 协议，安全逻辑公开接受社区审查（Security through transparency，而非 obscurity）。
5. **Edge 优先**：默认兼容 Vercel Edge / Cloudflare Workers / Node.js 三种运行时。

## 开源协议

计划采用 **MIT License**。核心防护逻辑公开透明，但具体项目的密钥、Redis 连接串、加密盐值等敏感配置永远通过环境变量注入，不写入本仓库。

---

具体的技术选型、Monorepo 架构、构建/发布流程与路线图见 [temp/plan.md](./temp/plan.md)。
