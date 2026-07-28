# Mita

**一套开箱即用、框架无关（Framework-agnostic）的鉴权与反爬（Anti-abuse）防护 SDK。**
一次编写核心逻辑，同时适配 Next.js / Nuxt / React / Vue / 原生 JS，供个人主页与后续所有项目复用。

[![core](https://img.shields.io/npm/v/@mita-auth/core?label=core)](https://www.npmjs.com/package/@mita-auth/core)
[![server](https://img.shields.io/npm/v/@mita-auth/server?label=server)](https://www.npmjs.com/package/@mita-auth/server)
[![client](https://img.shields.io/npm/v/@mita-auth/client?label=client)](https://www.npmjs.com/package/@mita-auth/client)
[![react](https://img.shields.io/npm/v/@mita-auth/react?label=react)](https://www.npmjs.com/package/@mita-auth/react)
[![vue](https://img.shields.io/npm/v/@mita-auth/vue?label=vue)](https://www.npmjs.com/package/@mita-auth/vue)
[![license](https://img.shields.io/npm/l/@mita-auth/core)](./LICENSE)

> 状态：五个包均已发布到 npm。[Next.js + Nuxt playground](./apps/playground) 已验证「零框架适配代码」的承诺：两个 demo 共用六个逐字节相同的业务模块，SDK 触碰面仅 4 处差异且全部是框架惯例。`@mita-auth/server` 在 Cloudflare Workers 与 Vercel Edge 上实测过：同一条 guard 链路逐行一致，不改一行源码，也不需要 `nodejs_compat`。

*[English version](./README.md)*

---

## 安装

装上服务端 guard 与浏览器客户端即可；框架绑定按需引入，`@mita-auth/core` 会作为它们的依赖一并装上。

```sh
npm i @mita-auth/server @mita-auth/client
npm i @mita-auth/react   # 或 @mita-auth/vue
```

需要 Node.js 22+，或任何在 `globalThis` 上暴露 WebCrypto 的运行时——Cloudflare Workers、Vercel Edge、Deno、现代浏览器。

## 这是什么

留言板 / 评论区常见的安全防护——人机验证、速率限制、XSS 内容清洗、防重放签名——本质上和 UI 框架无关，却常常在每个新项目里被重新实现一遍。Mita 把这套逻辑抽成一个独立、可审计的开源 SDK：核心只做"粘合层"，绑定社区验证过的成熟依赖，而不是重新发明密码学或限流算法。

## 设计目标

1. **框架无关**：核心逻辑不依赖任何 UI 框架，React / Vue / Svelte / 原生 HTML 均可直接使用。
2. **不重复造轮子**：只做粘合层与开箱即用的默认配置，密码学、网络请求、限流算法全部依赖社区验证过的成熟库。
3. **按需引入**：拆分为多个小包，避免前端项目被迫引入 Node.js 专属依赖。
4. **开源 + 可审计**：MIT 协议，安全逻辑公开接受社区审查（Security through transparency，而非 obscurity）。
5. **Edge 优先**：默认兼容 Vercel Edge / Cloudflare Workers / Node.js 三种运行时。

## 开源协议

采用 **MIT License**，见 [LICENSE](./LICENSE)。核心防护逻辑公开透明，但具体项目的密钥、Redis 连接串、加密盐值等敏感配置永远通过环境变量注入，不写入本仓库。

---

每个包的 API 面、线上格式与运行时要求都记录在各自的 README 里：[core](./packages/core)、[server](./packages/server)、[client](./packages/client)、[react](./packages/react)、[vue](./packages/vue)。其背后的技术选型与架构决策以开发笔记的形式保留在工作区中，不随仓库公开。
