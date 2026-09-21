<div align="center">

# AgentHub

### 一个人，也能拥有一支 Agent 团队。

**AgentHub 是一个通过 API 驱动的多 Agent 调度与管理平台，让你能够围绕现有 AI 工具建立属于自己的个人 Agent 团队。**

**中文** · [English](./README.md)

> 当前为开发 / 测试版本：核心能力已经可以运行，但功能尚未完整，项目仍在持续开发中，并非最终用户发行版。

</div>

---

## AgentHub 是什么？

AgentHub 的目标不是再做一个单独的 AI 聊天工具，而是把多个原本彼此独立的 AI Agent 组织成一支可以被管理、调度、审查的团队。

系统提供统一的 Agent 管理层，用于管理职位、职责、任务、计划、调度、执行、Review、审批以及不同 Provider 的接入。

每个 Agent 都可以拥有自己的职位和职责。对于个人用户来说，这意味着可以用一套系统建立自己的“AI 团队”，而不是同时打开多个互不相干的 AI 工具。

AgentHub 采用 **API First** 的架构。桌面端、未来的 Web 管理端、手机 App、远程节点都可以连接到同一个权威 Backend，而不需要在每一个客户端里重新实现一套调度系统。

我们的长期目标很简单：

> **让一个人，也可以拥有一支可管理、可审查、可扩展的 AI Agent 团队。**

---

## 为什么做 AgentHub？

现在的 AI 编程工具已经非常强，但大多数工具依然是彼此隔离的。

AgentHub 重点解决的不是“再做一个 Agent”，而是解决 **Agent 与 Agent 之间如何被统一管理和协作** 的问题。

### 核心方向

- **多 Agent 统一管理** —— 在一个控制层里管理多个 Agent、职位、职责和运行状态。
- **自动任务拆分 / 调度** —— Plan 可以被转化为具体 Task，并通过 Backend 生命周期进行调度和分发。
- **Review / 审批闭环** —— Agent 执行完成不代表任务天然正确，Review 和人工审批属于正式生命周期的一部分。
- **Provider 统一接入** —— 不同 Agent 工具通过统一 Provider 抽象接入 AgentHub。
- **职位化 Agent 团队** —— Agent 不只是匿名并发进程，而是可以拥有不同职位与职责。
- **面向多电脑协作的架构** —— API First 设计使远程客户端、多设备和未来多节点成为可能，同时不把调度权下放给 UI。
- **API 扩展性高** —— 未来的客户端、自动化、第三方集成和设备连接方式都可以复用同一套 Backend 契约。

---

## 当前 Provider

当前 AgentHub Backend 已包含以下 Provider 接入：

- **Claude**
- **OpenAI Codex**
- **Cursor**
- **Antigravity**

后续会随着 Provider 抽象继续完善，逐步增加更多 Agent / Provider。

---

## 基础架构

AgentHub 当前坚持以下权威边界：

```text
Human decides.
Backend owns truth.
Desktop presents and mediates.
Providers execute.
Agents do work.
Review validates.
Office visualizes.
```

可以简单理解为：

```text
                         ┌─────────────────────┐
                         │        用户         │
                         │     Human Boss      │
                         └──────────┬──────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │     AgentHub Desktop      │
                    │ UI / 草稿 / 用户操作意图  │
                    └─────────────┬─────────────┘
                                  │
                         HTTP API + WebSocket
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │     AgentHub Backend      │
                    │       权威状态中心         │
                    ├───────────────────────────┤
                    │ Plan / Task / Agent       │
                    │ Scheduler / Dispatcher    │
                    │ Review / Recovery         │
                    │ Provider 抽象层            │
                    └─────────────┬─────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
          ┌──────────┐      ┌──────────┐      ┌──────────┐
          │  Claude  │      │  Codex   │      │  Cursor  │
          └──────────┘      └──────────┘      └──────────┘
                                  │
                                  ▼
                           ┌─────────────┐
                           │ Antigravity │
                           └─────────────┘
```

Desktop **不是第二个 Backend**。

真正的 Plan、Task、Assignment、Review、Provider Runtime 等权威状态由 Backend 持有。客户端负责展示状态、保存临时 UI 信息和提交用户意图，执行 mutation 后重新从 Backend 同步权威状态。

Realtime 事件主要作为状态失效通知 / 重新同步触发器，而不是第二套状态来源。

---

## AgentHub Desktop

AgentHub Desktop 是整个项目的可视化与交互层。

它负责向用户展示 Agent、生命周期、Task、Review、Provider 信息以及办公室式的 Agent 可视化界面。

Desktop 项目单独维护：

**仓库：** `704986409/AgentHub-Desktop`

AgentHub Desktop 基于 Munder Difflin 桌面项目继续开发。上游来源、基线与审计信息保留在 Desktop 仓库中。

---

## 当前开发状态

AgentHub 目前已经存在可以运行和测试的开发版本，但功能还没有全部完成。

Backend 已经不再是最初单纯的数据层，目前已经包含生命周期执行、调度、Assignment 管理、Provider 接入、Review、Recovery、权威状态 API 和实时失效通知等能力。

但目前仍应视为 **持续开发中的测试版本**：

- API 和 UI 仍有继续变化的可能。
- 面向公网使用的安全层还没有完整收口。
- 当前还没有最终面向普通用户的安装发行流程。
- 目前推荐开发者直接通过源码进行测试和开发。

> **当前开发版 Backend 不建议在没有额外安全层的情况下直接暴露到公网。**

---

## 截图占位

<!-- 后续把下面占位替换为真实项目截图。 -->

> **Desktop 总览截图占位**  
> 建议路径：`docs/images/agenthub-desktop-overview.png`

> **生命周期 / 任务管理截图占位**  
> 建议路径：`docs/images/agenthub-lifecycle.png`

> **Agent 办公室可视化截图占位**  
> 建议路径：`docs/images/agenthub-office.png`

> **完整架构图占位**  
> 建议路径：`docs/images/agenthub-architecture.png`

---

## 从源码运行

当前阶段主要面向希望从源码构建、测试和参与开发的开发者。

### 1. Backend

环境要求：

- Node.js **20+**
- npm
- 根据需要安装对应的 Agent 工具

```bash
git clone https://github.com/704986409/AgentHub.git
cd AgentHub

npm install
npm run check
npm run build

node dist/cli.js serve
```

Backend 默认地址：

```text
http://127.0.0.1:3210
```

常用 Backend 命令：

```bash
npm run typecheck
npm run build
npm run lint
npm test
npm run check
```

Codex 环境诊断：

```bash
node dist/cli.js doctor
```

### 2. Desktop

```bash
git clone https://github.com/704986409/AgentHub-Desktop.git
cd AgentHub-Desktop

npm install
npm run dev
```

Desktop 通过 HTTP API 与 AgentHub Backend 通信，同时通过 WebSocket 接收实时状态变化通知。

---

## API First

AgentHub 的核心设计之一，就是把真正的调度与生命周期权威放在 Backend。

因此未来增加新的客户端时，不需要把 Scheduler、Dispatcher、Review、Recovery 再重新实现一次。

未来客户端可以包括：

```text
Desktop App
Web 管理端
手机 App
远程控制端
其他 AgentHub Node
自动化 / 第三方集成服务
```

这也意味着 AgentHub 天然适合未来的“个人 Agent 团队”场景：

```text
一台设备下发任务
↓
另一台可信电脑上的 AgentHub Backend 接收
↓
本地 Agent 团队开始执行
↓
结果重新同步到用户设备
```

---

## Roadmap / 未来计划

目前计划中的方向包括但不限于：

- **手机 App** —— 作为个人 Agent 团队 / 私人 Agent 助理的移动入口。
- **Web 管理端** —— 通过浏览器管理 AgentHub。
- **P2P 设备连接** —— 探索更加隐私的设备到设备连接方式。
- **二维码设备配对** —— 简化可信设备之间的初次绑定。
- **多电脑 / 多节点 AgentHub** —— 让不同电脑和 AgentHub Node 可以协作。
- **更加隐私的消息传送方式** —— 具体传输协议仍在评估，目前不提前锁定技术方案。
- **JevAI 接入** —— 将 JevAI 接入 AgentHub 生态，并探索其在路由 / 神经反射层中的作用。
- **更多 Provider** —— 随着 Provider 抽象成熟继续扩展。
- **正式发行版 / 安装包** —— 在整体系统稳定后，从源码开发模式逐步进入可安装发行阶段。

Roadmap 会随着真实测试结果和架构验证继续调整。

---

## 手机端愿景

未来手机端的定位不只是“远程桌面”。

我们希望它成为用户随身携带的 **个人 Agent 团队 / 私人 Agent 助理**：

```text
你
 │
 │ 创建任务 / Review / Approve
 ▼
AgentHub Mobile
 │
 │ 安全远程连接
 ▼
AgentHub Backend
 │
 ├─ Plan
 ├─ Task
 ├─ Scheduler
 ├─ Dispatcher
 ├─ Review
 └─ Provider
      │
      ▼
你的 Agent 团队
```

最终用户可以在手机上：

```text
创建任务
查看 Agent 工作进度
查看执行结果
进行 Review
批准 / 驳回
管理自己的 Agent 团队
```

而真正的执行可以发生在另一台可信电脑上。

---

## 设计原则

AgentHub 当前开发过程中有几条不会轻易改变的原则：

1. **最终决策者始终是真实用户。**
2. **Backend 持有权威状态。**
3. **客户端只负责展示、协调 UI 和提交用户意图，不自行创造生命周期事实。**
4. **不同 Provider 通过统一抽象执行真实工作。**
5. **Review 是正式生命周期的一部分，而不只是 UI 装饰。**
6. **当无法确认执行副作用时，Recovery 必须 Fail Closed。**
7. **扩展能力应该来自稳定 API / Contract，而不是让每个客户端复制一套调度系统。**

---

## 项目仓库

| 仓库 | 作用 |
|---|---|
| `704986409/AgentHub` | Backend、生命周期、调度、Provider、Review、Recovery、API |
| `704986409/AgentHub-Desktop` | Desktop 可视化、交互、生命周期工作区、开发者 UI |

---

## 参与开发

AgentHub 目前仍处在快速迭代阶段。

欢迎提交：

```text
Issue
测试反馈
架构讨论
Provider 接入建议
可复现 Bug
```

参与开发时，请尽量不要把权威生命周期逻辑移动到客户端。Backend 应继续保持整个系统的权威状态中心。

---

## 使用与许可说明

AgentHub 当前允许 **个人、非商业用途** 使用。

**未经项目所有者单独授权，不允许将本项目用于商业用途。**

这属于源码可见的个人 / 非商业使用政策，不应被理解为 OSI 定义下的标准开源许可证。后续可以通过独立的 LICENSE 文件补充完整法律条款。

---

## 致谢

AgentHub Desktop 基于 Munder Difflin 桌面项目继续开发。

我们保留并尊重上游项目及其贡献者的工作，Desktop 仓库中同时保留来源、基线和相关审计说明。

---

<div align="center">

### Build your own Agent team.

**一个人，也能拥有一支团队。**

[English](./README.md)

</div>
