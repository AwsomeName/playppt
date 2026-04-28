# PPT 讲解 Agent 项目文档

> **文档优先级**：当本文档与 `docs/ai-dev-plan.md` 存在冲突时，以 `ai-dev-plan.md` 为准（该文档为 AI 执行唯一真相源）。

## 1. 项目概述

本项目实现一个基于 Web-PPT 的讲解 Agent，提供以下主链路：
1. 加载并播放 PPT（浏览器环境）。
2. 按页面朗读讲解词并控制翻页。
3. 接收用户语音提问并基于 PPT 内容回答。
4. 回答后恢复讲解流程。

## 1.1 运行与环境

新环境从克隆（或解压）代码、安装依赖到启动本地前后端的步骤，见仓库根目录 **README.md** 中的 **「新环境：安装与启动」**；验收命令与里程碑仍以 `docs/ai-dev-plan.md` 为准。

## 2. 建议架构

> **总览**（产品边界、分层职责、口播+检索+问答数据、**控制命令有限集**、章节与 XState/测试策略）以 `docs/ai-dev-plan.md` **第 1.1 节**为准；下文为便于阅读的摘要。

采用“前端控制台 + Agent 服务 + AI 能力层”的分层结构。

- **Web 客户端（Presentation UI）**
  - PPT 播放容器
  - 控制面板（开始、暂停、翻页、会话状态）
  - 音频播放与麦克风采集
  - **不另造**与后端并行的业务状态机；展示与上报以后端为真源

- **Agent Orchestrator（服务层）**
  - 状态机：idle / presenting（含子状态 narrating / waiting_confirm / auto_advance） / paused / qa / interrupted / end
  - 事件总线：页面变更、语音输入、问答输出
  - 指令路由：翻页、讲解、问答、恢复；**HTTP 控制面**与 `action` 清单见 `ai-dev-plan` 第 1.1.5 节与第 2.1 节 E

- **AI 能力层**
  - ASR：语音转文本
  - NLU：意图识别（**先**有限控制命令，**后**自由提问；见第 1.1.4 节）
  - RAG：页面内容检索
  - LLM：回答生成
  - TTS：语音播报
  - 统一超时/重试/降级（`ai-dev-plan` 第 2.1 节 D、第 4.8 节）

- **数据层**
  - PPT 结构化内容（页码、标题、正文、口播 `script`；RAG 默认可用 `title+content+script` 拼块，见第 1.1.3 节）
  - 可选：场级 `qaPolicy`、页级 `scope`；可选 `chapters[]`（有则 NLU 可将「到第 X 章」解析为 `goto(章首页)`，无数据则不保证该命令，见第 1.1.6 节）
  - 会话上下文（当前页、历史问答、控制状态；每页 `PageContext` 见 `ai-dev-plan` 第 4.6 节）
  - 日志与埋点

## 3. 模块设计

## 3.1 PPT 控制模块

职责：
- 初始化演示。
- 暴露统一接口：`next()`, `prev()`, `goTo(page)`, `getCurrentPage()`。
- 页面切换后通知讲解模块开始工作。

关键点：
- 兼容不同 Web-PPT 渲染方案（可通过适配器模式）。
- 控制调用需幂等，避免重复翻页。

## 3.2 讲解模块

职责：
- 读取当前页讲解词并调用 TTS 播放。
- 支持打断、暂停、恢复。

关键点：
- 每页讲解词可预置，也可运行时生成兜底文案。
- 播放完成触发下一动作（自动翻页或等待）。

## 3.3 语音交互模块

职责：
- 采集麦克风输入并调用 ASR。
- 对 ASR 文本进行意图识别。

关键点：
- 指令词优先级高于问答（如“下一页”应立即执行）。
- 识别低置信度时做二次确认或提示重说。

## 3.4 问答模块

职责：
- 基于当前页 + 全文检索上下文。
- 调用大模型生成回答。
- 返回文本与 TTS 播放内容。

关键点：
- 回答带页码来源，提升可解释性。
- 无依据时返回“无法确认”，避免幻觉。

## 3.5 会话状态机

> **注意**：状态机的完整规范（状态定义、事件、转移规则、子状态、守卫条件、降级策略）以 `docs/ai-dev-plan.md` 第 4 章为准。以下仅为概要。

顶层状态：`idle / presenting / paused / qa / interrupted / end`

`presenting` 含子状态：`narrating / waiting_confirm / auto_advance`

核心流转：
- `idle` -> `presenting.narrating`：开始演示（`START`）
- `presenting.*` -> `qa`：用户提问（`QUESTION_DETECTED`，打断当前播报）
- `qa` -> `presenting.narrating`：回答结束恢复讲解（`QA_DONE`）
- `presenting.*` -> `paused`：用户暂停（`PAUSE`）
- `paused` -> `presenting.narrating`：恢复（`RESUME`）
- `presenting.*` -> `interrupted`：可恢复异常（`ERROR_RECOVERABLE`）
- `interrupted` -> `presenting.narrating`：恢复（`RESUME`）
- 任意状态 -> `end`：结束演示（`STOP`）

## 4. 数据模型（建议）

```json
{
  "presentation": {
    "id": "ppt_001",
    "title": "产品介绍",
    "chapters": [
      { "id": "ch1", "title": "第一章", "startPage": 1, "endPage": 5 }
    ],
    "qaPolicy": { "preferCurrentPage": true },
    "pages": [
      {
        "pageNo": 1,
        "title": "封面",
        "content": "......",
        "script": "欢迎大家参加今天的介绍",
        "scope": "this_page"
      }
    ]
  },
  "session": {
    "sessionId": "sess_xxx",
    "currentPage": 1,
    "state": "presenting",
    "history": []
  }
}
```

- `chapters` / `qaPolicy` / `scope` 为**可选**；MVP 可仅有 `pages[]` 与每页 `script`，与 `fixtures/demo.json` 渐进对齐即可（详见 `ai-dev-plan` 第 1.1.3、4.12 节）。

## 5. 接口草案

> **注意**：接口契约的完整定义以 `docs/ai-dev-plan.md` 第 2.1 节 E 和第 4.9 节为准。以下仅为概要。

- `POST /api/session/start`
  - 入参：`{ presentationId }`
  - 出参：`{ sessionId, totalPages, state: "idle" }`

- `POST /api/control`
  - 入参：`{ sessionId, action: "start|next|prev|goto|pause|resume|stop", page?: number }`
  - 出参：`{ ok, currentPage, state, message? }`

- `POST /api/ask`
  - 入参：`{ sessionId, question, currentPage }`
  - 出参：`{ answerText, sourcePages, confidence?, fallbackMode? }`

- `GET /api/session/:id`
  - 出参：`{ sessionId, currentPage, state, mode, updatedAt, pages[] }`

## 6. 开发里程碑

> 阶段划分、依赖关系与验收以 `docs/ai-dev-plan.md` **第 5 章（M0–M5）** 为准。以下为与业务相关的速记。

- **M0**：脚手架、健康检查、示例 `fixtures`。
- **M1**：播放 + 控制 API + 状态机骨架 + 前后端联调。
- **M2**：TTS 与口播、自动/手动翻页策略。
- **M3**：ASR + 意图（归一化到第 1.1.5 节 `action` 集）。
- **M4**：RAG/LLM 问答、TTS 播报回答。
- **M5**：日志持久化、降级与稳定性、会话日志导出等。

## 7. 测试建议

- **单元测试**：状态机转移、Guards、幂等、关键事件序列（`ai-dev-plan` 第 2.1 节 C、第 4.10 节）。
- **API 测试**：`session` / `control` / `ask` 随里程碑落地补全。
- **E2E（仓库内）**：建议 Playwright 等覆盖主路径；用于 CI/回归。

- **功能测试**
  - 翻页指令正确性（边界页、跳页、快速连发）；控制面与第 1.1.5 节一致。
  - 讲解播放与中断恢复。
  - 问答相关性（当前页优先；有 `qaPolicy`/`scope` 时按配置）。

- **性能测试**
  - 语音识别延迟、问答延迟、长会话稳定性。

- **异常测试**
  - 麦克风权限拒绝、网络抖动、TTS/LLM 超时降级。

- **开发期工具**
  - **MCP 驱动浏览器**（**强约束**）：在 Cursor 等环境通过 MCP 操作本机浏览器时，**必须**只使用 **Playwright 官方 MCP**（`@playwright/mcp`），详见 `ai-dev-plan` 第 1.1.9 节与第 2 节；**禁止**在默认/推荐方案中使用其它浏览器类 MCP。仓库 E2E 使用 Playwright Test，**不**由 MCP 替代。

## 8. 风险与应对

- 语音识别噪声导致误触发：
  - 增加唤醒词或命令确认机制。

- 问答准确性不稳定：
  - 强化检索约束，回答附来源页码。

- 第三方服务波动：
  - 增加重试与本地兜底策略（文本展示替代语音）。
