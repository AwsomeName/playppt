# PPT 讲解 Agent AI 开发执行计划

本文档用于指导 AI 编码代理（如 Cursor Agent）按阶段完成 `play-ppt` 的 MVP 开发，目标是让 AI 可以“拿着计划就开工”，并在每一步输出可验收结果。

## 1. 执行目标

- 在浏览器中播放 Web-PPT，并支持程序化翻页控制。
- 支持每页讲解词 TTS 播放与自动/手动翻页策略。
- 支持用户语音提问，并基于 PPT 内容回答。
- 实现最小可用日志与会话管理，保证可调试、可复盘。

### 1.1 整体架构、数据、命令与工程策略

本节是「怎么落地」的集中说明，与后文第 4 章（状态机）、第 2.1 节（执行约束/接口）配套使用。

#### 1.1.1 产品边界（MVP）

- 必须：Web-PPT 播放与程序化/接口翻页、每页口播（`script`）+ TTS、用户语音/文本输入、基于演示内容的问答（可附 `sourcePages`）、外部服务不可用时 mock/降级、可调试日志。
- 不强制（非 MVP 或数据依赖才启用）：**「第 X 章」**类跳转（需演示数据提供**章到页**映射时方可作为**可保证命令**）。

#### 1.1.2 分层与单一真源

| 层 | 职责 |
|----|------|
| **Web 客户端**（`apps/web`） | PPT 容器、控制与状态展示、音频/麦克风、将播放起止与错误对齐后端。 |
| **Agent 服务**（`apps/server`） | **唯一会话真源**：状态机、Guards、幂等、`/session` `/control` `/ask` 编排；**禁止在 Controller 内硬编码状态转移**（与第 4.10 节一致）。 |
| **AI 能力** | ASR、意图、RAG/LLM、TTS；统一超时/重试/降级（第 2.1 节 D、第 4.8 节）。 |
| **数据** | 演示物（见 1.1.3）+ 会话 + `PageContext`（第 4.6 节）+ 日志；MVP 可内存 + JSON 文件，先定**字段契约**再换存储。 |

- **状态以后端为准**（`currentPage`、顶层/子状态、`fallbackMode`等）；前端避免独立实现一套并行业务 FSM，仅展示与上报事件。

#### 1.1.3 演示数据与问答范围

演示数据在 `fixtures/*.json`（或同构来源）中至少需区分**语义**（可同文件多字段，不必首版拆多文件）：

- **页内容（展示与检索）**：`pageNo`、`title`、`content`；RAG 的默认可检索语料为每页 **`title + content + script` 拼块**（M4 可按需增强索引）。
- **口播（TTS 主链）**：`script`（M2 必绑）；`PageContext.narrationProgress` 等见第 4.6 节。
- **问答范围（建议字段，可逐步补齐）**：
  - 页级：如 `scope`（本页优先 / 含相关页 / 全场，枚举由实现定）、`relatedPageNos` 可选；
  - 场级：如 `qaPolicy`（当前页优先、向全局扩展的条件、无依据时话术）。

#### 1.1.4 用户输入：控制命令与自由提问

- 两路：先判**是否命中控制命令**；命中则**优先**走控制事件（不进入 `qa`）；否则作**自由提问**并触发 `QUESTION_DETECTED`（在允许的会话态下，第 4 章）。
- **控制命令 = 有穷集**：语音/意图只负责**归一化**到与 `POST /api/control` 的 `action` 一致，避免 FSM 输入空间爆炸。

#### 1.1.5 控制动作清单（与第 2.1 节 E 对齐）

MVP 应保证的 `action` 与语义（实现可用同义词/正则映射到此集合）：

| `action` | 含义 | 参数 | 状态机侧（常见） |
|----------|------|------|------------------|
| `start` | 从 idle 等允许态开始讲解 | 无 | `START` |
| `next` | 下一页 | 无 | `NEXT` |
| `prev` | 上一页 | 无 | `PREV` |
| `goto` | 到指定页 | `page: number`（Guards 钳制边界，第 4.5 节） | `GOTO` |
| `pause` | 暂停 | 无 | `PAUSE` |
| `resume` | 恢复 | 无 | `RESUME` |
| `stop` | 结束会话 | 无 | `STOP` |

- 同义例：如「到第一页/最后一页」应解析为 `goto(1)` / `goto(totalPages)`。

#### 1.1.6 章节与「第 X 章」

- **不作为默认可选命令**；仅当演示数据提供 **`chapters[]`**（或等价结构，含 `id/title` 与 `startPage` 或 `startPage–endPage`）时，才将自然语言「到第 X 章/去第三章」**解析**为对某一页的 `goto(startPage)`（或你们约定的章首页）。
- 无 `chapters` 时：**不承诺**「到第 X 章」为稳定控制命令，可改用语义 `goto(页码)` 或**自由提问**由 M4 非确定性回答（弱于控制路径）。

#### 1.1.7 长耗时副作用与状态机

- TTS/LLM/ASR 为**副作用**；**进行中/完成/失败** 以 `TTS_DONE` `TTS_FAILED` 等事件**喂回** FSM，而不是把 HTTP 长调用写在转移表的每一步里，避免难测难维护（与第 4.7 节配合）。

#### 1.1.8 状态机实现与 XState

- **M1 及首版**：优先在 `apps/server` 内手写 `transition(state, event, payload) => { nextState, actions[] }`（第 4.10 节）+ 单元测；**不强制**引入 `xstate`。
- **当出现**：子状态与多源事件交织、手写字典难以维护时，**可**用 **XState 等库** 作为实现载体，**仅限后端会话 FSM**；**领域事件与 Guards 仍由本文档/第 4 章定义**，库不替代产品规则。

#### 1.1.9 测试与开发工具

- **单测**：纯转移、Guards、幂等、关键事件序列（每 Milestone 在「统一验收命令」基础上可增减）。
- **API 测**：`session` / `control` / `ask`（随里程碑落地补全）。
- **E2E（仓库内、可重复/CI）**：**必须**使用 **Playwright Test**（`@playwright/test` 等，随仓库脚本落地）编写；覆盖「建会话、翻页、主界面关键路径」等，与下方 **MCP** 职责**分离**。
- **通过 MCP 操作本机浏览器（开发/联调/由 AI 代理驱动浏览器）— 强约束**：
  - **必须**且**仅**使用 **Playwright 官方 MCP**：npm 包 **`@playwright/mcp`**，维护方与文档以 [playwright.dev/mcp](https://playwright.dev/mcp/introduction) 及 [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) 为准；在 Cursor 等客户端的 `mcpServers` 中应配置为通过 `npx` 等调用该包（版本见官方说明）。
  - **禁止**将**其它**以 MCP 方式驱动浏览器的 Server（含非官方、第三方「浏览器 / 自动化」类 MCP）作为本项目的**默认、推荐或文档中的示例联调方案**；确需替代方案时，须**先修订本段**并经维护者确认。
  - **说明**：本约束针对 **MCP 通道**；**不**要求终端用户日常访问产品经过 MCP。最终用户仍通过普通浏览器使用 `apps/web`。
  - 该 MCP **不是** `package.json` workspace 必装依赖，而是**本机/IDE 的 MCP 客户端配置**；与 E2E 的 `@playwright/test` **不互相替代**（见上条 E2E）。

## 2. AI 执行规则（强约束）

- 每次只做一个里程碑范围内的任务，避免大爆改。
- 每完成一个子任务，必须：
  - 更新代码；
  - 运行最小验证（启动/测试/接口调用）；
  - 输出“变更文件 + 验证结果 + 下一步”。
- 若遇到阻塞（依赖不可用、接口不通），先实现可运行 mock，不中断主流程。
- 所有新增能力都要可关闭（feature flag 或配置开关）。
- **MCP 与浏览器（与第 1.1.9 节一致）**：凡在本仓库工作流中需**通过 MCP 让代理/工具操作本机浏览器**（联调、探索性点击、可访问性树交互等），**必须**只使用 **官方 `@playwright/mcp`**；**不得**在文档、默认配置或「推荐联调方式」中引入**其它**浏览器类 MCP 作为等价替代，除非已按第 1.1.9 节更新本文件并获维护者确认。

## 2.1 AI 执行输入约束（新增，强约束）

> 每次让 AI 开工前，先补全以下信息；若缺失，AI 先最小实现并在输出中标注假设。

### A. 仓库与技术栈映射（已补全，可执行默认值）

> 本仓库已包含 `apps/web`、`apps/server`、根 `package.json` 等；若与下表路径不一致，以**实际代码**为准并**同步更新本段**。新初始化工程时，AI 可据此从 `M0` 起对齐目录与脚本。

- 前端目录：`apps/web`
- 后端目录：`apps/server`
- 包管理器与命令：`npm`（workspace）
- 运行入口（约定）：
  - 前端：
    - `npm run dev -w apps/web`
    - `npm run build -w apps/web`
    - `npm run start -w apps/web`
  - 后端：
    - `npm run dev -w apps/server`
    - `npm run build -w apps/server`
    - `npm run start -w apps/server`
  - 仓库根目录（并行启动）：
    - `npm run dev`

### B. 允许改动范围（已补全）

- 允许修改：
  - `apps/**`
  - `packages/**`（如后续新增共享包）
  - `docs/**`
  - `README.md`
  - `.env.example`
  - 根目录 `package.json`、`tsconfig*.json`（仅在初始化脚手架必需时）
- 禁止修改：
  - `.git/**`
  - `.github/**`（若后续新增）
  - `node_modules/**`
  - `dist/**`、`build/**`
- 规则：若任务需要改“禁止修改”区域，AI 必须先停下并请求确认。

### C. 统一验收命令（已补全）

- 每个 Milestone 完成后至少执行：
  - `npm run lint`
  - `npm run test`
  - `npm run build`
- 若仓库当前无测试，至少执行可运行验证：
  - `npm run dev`
  - 并给出最小验证步骤（至少包含：打开页面、调用 1 个控制接口、查看 1 条日志）。
- 对于尚未初始化完成导致命令不存在的阶段：
  - AI 需先在本次任务中补齐对应脚本；
  - 若仍不可执行，必须在结果中明确列出“缺失项 + 临时验证方式”。

### D. 外部依赖与 Mock 兜底（已补全）

- 依赖清单（默认）：
  - ASR：`OpenAI gpt-4o-mini-transcribe`
  - LLM：`OpenAI gpt-4.1-mini`
  - TTS：`OpenAI gpt-4o-mini-tts`
- 不可用判定（任一满足即触发 mock）：
  - 鉴权失败；
  - 配额不足；
  - 网络超时（> `15` 秒）；
  - 连续 `2` 次 5xx。
- Mock 策略：
  - ASR mock：返回固定文本（例如“下一页”）或本地示例转写文本；
  - LLM mock：基于当前页 `script` 返回模板化答案，并附 `sourcePages`；
  - TTS mock：返回可播放占位音频 URL，若不可用则退化为文本展示。

### E. 接口契约最小草案（已补全）

> 控制面 `action` 的**语义与命令清单**见**第 1.1.5 节**；本章仅列 HTTP 形状。

- 创建会话：`POST /api/session/start`
  - request: `{ presentationId }`
  - response: `{ sessionId, totalPages, state: "idle" }`
- 控制接口：`POST /api/control`
  - request: `{ sessionId, action: "start|next|prev|goto|pause|resume|stop", page?: number }`
  - response: `{ ok, currentPage, state, message? }`
- 问答接口：`POST /api/ask`
  - request: `{ sessionId, question, currentPage }`
  - response: `{ answerText, sourcePages, confidence?, fallbackMode? }`
- 会话状态：`GET /api/session/:id`
  - response: `{ sessionId, currentPage, state, mode, updatedAt, pages[] }`

### F. 前置依赖与执行顺序（已补全）

- 默认顺序：`M0 -> M1 -> M2 -> M3 -> M4 -> M5`
- 进入下一 Milestone 条件：
  - 当前 Milestone 的“验收标准 + 统一验收命令”全部通过；
  - 若使用了 mock，需在报告中列出替换为真实依赖的待办；
  - 需要新增目录或基础脚手架时，优先在 `M0` 完成，不得在后续里程碑重复重构基础结构。

## 3. 技术基线（建议）

- 前端：React + TypeScript（PPT 播放与交互界面）
- 后端：Node.js + TypeScript（Agent 编排服务）
- 实时通信：WebSocket（可选，先用 HTTP 也可）
- AI 组件：
  - ASR（语音转文本）
  - LLM（问答）
  - TTS（文本转语音）
- 存储：
  - MVP 可先用内存态 + JSON 文件持久化
  - 后续替换 DB

> 注：若当前仓库技术栈不同，AI 以“复用现有栈优先”，不强制迁移。

## 4. 后端状态机设计（MVP，新增强约束）

### 4.1 设计目标

- 用确定性状态机驱动主链路，不使用自由协作型多 Agent 作为流程主控。
- 控制类动作（翻页/暂停/恢复）必须低延迟、可预测、可回放。
- 问答链路可调用 LLM，但状态流转由后端状态机统一裁决。

### 4.2 状态定义

#### 顶层状态

- `idle`：会话已创建但未开始播放。
- `presenting`：正在讲解流程中（含子状态，见下方）。
- `paused`：人工暂停或系统降级暂停。
- `qa`：处理用户提问（检索、生成、播报回答）。
- `interrupted`：出现可恢复异常，等待恢复指令。
- `end`：会话结束，不再接受业务事件（仅保留查询/导出）。

#### `presenting` 子状态（层级状态机）

- `presenting.narrating`：正在播报当前页讲解词（TTS 播放中）。
- `presenting.waiting_confirm`：当前页讲解词播完，等待用户确认翻页（手动翻页模式）。
- `presenting.auto_advance`：当前页讲解词播完，正在执行自动翻页倒计时（自动翻页模式）。

子状态内部转移：
- `presenting.narrating` + `TTS_DONE` -> `presenting.waiting_confirm`（手动模式）或 `presenting.auto_advance`（自动模式）
- `presenting.auto_advance` + 倒计时结束 -> 触发 `NEXT` -> `presenting.narrating`（下一页开始讲解）
- `presenting.waiting_confirm` + `NEXT/GOTO` -> `presenting.narrating`（用户确认后翻页并开始讲解）

子状态对外部事件的响应（任一子状态均可被抢占）：
- `PAUSE` -> 退出 `presenting`，进入 `paused`
- `QUESTION_DETECTED` -> 退出 `presenting`，进入 `qa`（打断当前播报）
- `ERROR_RECOVERABLE` -> 退出 `presenting`，进入 `interrupted`
- `STOP` -> 退出 `presenting`，进入 `end`

### 4.3 事件定义

- 会话事件：`START`, `STOP`, `TIMEOUT`, `ERROR_RECOVERABLE`, `ERROR_FATAL`
- 控制事件：`NEXT`, `PREV`, `GOTO`, `PAUSE`, `RESUME`
- 讲解事件：`SCRIPT_START`, `SCRIPT_DONE`, `TTS_DONE`, `TTS_FAILED`
- 语音问答事件：`VOICE_COMMAND`, `QUESTION_DETECTED`, `QA_DONE`, `QA_FAILED`

### 4.4 状态转移规则（实现基线）

- `idle`
  - `START` -> `presenting`
  - `STOP` -> `end`
- `presenting`
  - `PAUSE` -> `paused`
  - `QUESTION_DETECTED` -> `qa`
  - `ERROR_RECOVERABLE` -> `interrupted`
  - `STOP` -> `end`
- `paused`
  - `RESUME` -> `presenting`
  - `STOP` -> `end`
- `qa`
  - `QA_DONE` -> `presenting`
  - `QA_FAILED` -> `interrupted`
  - `STOP` -> `end`
- `interrupted`
  - `RESUME` -> `presenting`
  - `STOP` -> `end`
- `end`
  - 任何业务事件保持 `end`（忽略并记录日志）

### 4.5 守卫条件（Guards）

- `NEXT/PREV/GOTO` 仅允许在 `presenting` 或 `paused` 下执行。
- `QUESTION_DETECTED` 仅允许在 `presenting` 下进入 `qa`。
- `RESUME` 仅允许从 `paused` 或 `interrupted` 触发。
- 页码边界保护：
  - `GOTO(page)` 中 `page < 1` 则钳制为 `1`；
  - `page > totalPages` 则钳制为 `totalPages`。
- 幂等保护：同一 `eventId` 的重复事件不重复执行副作用（翻页、播报、写日志）。

### 4.6 页面级上下文模型（Page Context）

> 状态机管"会话在干什么"，页面上下文管"每一页发生了什么"。二者分离，互相引用。

#### 数据结构（每页一份，挂在会话下）

```ts
interface PageContext {
  pageNo: number;              // 页码
  status: PageStatus;          // 该页讲解状态
  narrationProgress: {
    totalChars: number;        // 讲解词总字数
    playedChars: number;       // 已播报字数（TTS 中断时记录）
    playedDurationMs: number;  // 已播报时长（毫秒）
    totalDurationMs: number;   // 预估总时长（首次 TTS 后回填）
  };
  visitCount: number;          // 进入该页次数（翻回来也算）
  firstVisitAt: string | null; // 首次进入时间（ISO）
  lastVisitAt: string | null;  // 最近进入时间（ISO）
  dwellMs: number;             // 累计停留时长（毫秒）
  qaHistory: PageQARecord[];   // 该页产生的问答记录
}

type PageStatus =
  | 'unvisited'     // 尚未翻到
  | 'narrating'     // 正在播报讲解词
  | 'narrate_paused'// 播报被暂停（人为或打断）
  | 'narrated'      // 讲解词已播完
  | 'skipped';      // 用户主动跳过（未播完就翻走）

interface PageQARecord {
  question: string;
  answer: string;
  sourcePages: number[];
  timestamp: string;           // ISO
}
```

#### 页面上下文更新时机

- **进入页面**（`NEXT/PREV/GOTO` 执行后）：
  - 新页 `visitCount++`，更新 `lastVisitAt`（首次同时写 `firstVisitAt`）；
  - 旧页累加 `dwellMs`；
  - 若旧页 `status = narrating` 且未播完，标记为 `skipped`，同时快照 `playedChars/playedDurationMs`。
- **讲解开始**（`SCRIPT_START`）：
  - `status = narrating`。
- **讲解完成**（`TTS_DONE`）：
  - `status = narrated`，回填 `totalDurationMs`，`playedChars = totalChars`。
- **讲解被打断**（`PAUSE` 或 `QUESTION_DETECTED`）：
  - `status = narrate_paused`，快照当前 `playedChars/playedDurationMs`。
- **恢复讲解**（`RESUME` / `QA_DONE` 回到本页）：
  - `status = narrating`，从 `playedChars` 位置续播（若 TTS 支持）或从头重播。
- **问答发生**：
  - 向当前页 `qaHistory` 追加记录。

#### 恢复策略（打断后回来怎么办）

- 默认策略：**从断点续播**（`playedChars` 位置切分讲解词，重新请求 TTS）。
- 若 TTS 不支持断点续播：**从当前页头重播**（`playedChars` 重置为 0）。
- 可通过配置切换：`resumeStrategy: 'continue' | 'restart'`。

#### 与状态机的关系

- 状态机负责流程（`presenting/qa/paused/...`）。
- 页面上下文是状态机的**扩展数据**，不影响状态转移逻辑。
- 状态机副作用函数中读写 `PageContext`，但 `PageContext` 的变化不会触发状态迁移。

### 4.7 副作用与动作（Actions）

- 所有状态迁移必须写入结构化日志：
  - `sessionId`, `fromState`, `toState`, `event`, `timestamp`, `metadata`
- `presenting` 下动作：
  - 执行页内讲解（TTS）；
  - 按策略决定自动翻页或等待确认。
- `qa` 下动作：
  - 检索当前页优先上下文；
  - 调用 LLM 生成回答并触发 TTS 播报；
  - 完成后发出 `QA_DONE`。
- `interrupted` 下动作：
  - 停止当前音频；
  - 回退到“手动翻页 + 文本回答”可用模式（若开启降级）。

### 4.8 超时与降级策略

- ASR/LLM/TTS 任一超时（> `15s`）或连续 `2` 次 5xx：
  - 触发 `ERROR_RECOVERABLE`；
  - 进入 `interrupted`；
  - 开启 `fallbackMode = true`。
- `fallbackMode = true` 时：
  - 禁用自动翻页；
  - 问答优先返回文本（TTS 失败可跳过）；
  - 明确向前端返回降级提示。

### 4.9 与 API 的映射约定

- `POST /api/session/start`
  - 创建会话，加载 PPT 数据，初始化所有 `PageContext`，状态置为 `idle`。
- `POST /api/control`
  - `action=start` 映射 `START`（`idle` -> `presenting.narrating`）
  - `action=next|prev|goto|pause|resume|stop` 分别映射 `NEXT|PREV|GOTO|PAUSE|RESUME|STOP`
- `POST /api/ask`
  - 前置校验当前状态为 `presenting.*`，通过后触发 `QUESTION_DETECTED`；
  - 完成后返回 `QA_DONE` 对应结果。
- `GET /api/session/:id`
  - 返回当前状态（含子状态，如 `presenting.narrating`）、`fallbackMode`、最近一次错误摘要。
  - 返回 `pages[]`（每页的 `PageContext` 摘要：`pageNo, status, narrationProgress, dwellMs, qaCount`）。

### 4.10 最小实现建议（代码层）

- 推荐后端维护单一 `StateMachine` 实例（每会话一份）：
  - `transition(currentState, event, payload) => { nextState, actions[] }`
- 推荐目录（示例）：
  - `apps/server/src/domain/state-machine.ts`
  - `apps/server/src/domain/events.ts`
  - `apps/server/src/services/session-service.ts`
- 严禁在 Controller 内硬编码状态流转；Controller 仅做参数校验与调用编排。

### 4.11 与第 1.1 节的关系

- **第 1.1 节**：整体架构、演示数据与问答范围、**有限控制命令**、章节约定、XState 与测试策略（概念与清单）。
- **第 4 章（4.1–4.10）**：状态、子状态、事件、Guards、`PageContext`、与 `POST` API 的映射（**规范**）。
- 实现上二者**对齐**：意图/控制层只能产生第 1.1.5 节所列 `action` 与第 4.3/4.5 节允许的事件；`PageContext` 不替代会话状态转移。其它产品文档如 `project.md` 有出入时，**以本文档为准**（见 `project.md` 文首声明）。

### 4.12 可持久化的演示物扩展（可选，与 M1 数据加载兼容）

当需要「章」或问答策略字段时，可在 PPT 演示 JSON 根级增加，例如（示意，非强制与首版 `demo.json` 同形）：

```json
{
  "presentationId": "demo",
  "title": "示例",
  "chapters": [{ "id": "ch1", "title": "第一章", "startPage": 1, "endPage": 5 }],
  "qaPolicy": { "preferCurrentPage": true },
  "pages": []
}
```

- 无 `chapters` 时，NLU 不得将「到第 N 章」**承诺**为硬控制，除非后续数据补齐。

## 5. 里程碑计划（AI 可直接执行）

### 里程碑依赖矩阵（新增）

- `M0` 是所有里程碑前置依赖。
- `M1` 依赖 `M0`。
- `M2` 依赖 `M1`。
- `M3` 依赖 `M1`（可并行准备，不与 `M2` 冲突）。
- `M4` 依赖 `M2 + M3`。
- `M5` 依赖 `M1 + M2 + M3 + M4`。

## Milestone 0：项目脚手架与规范（0.5 天）

### 目标
建立最小可运行工程与目录结构。

### 任务
- 初始化前后端基础目录（或在现有目录补齐模块）。
- 增加 `.env.example`、配置加载、日志工具。
- 增加 `README` 的运行说明（开发、构建、测试）。
- 创建示例 PPT 数据文件 `fixtures/demo.json`（至少 10 页，含 `pageNo/title/content/script`），供后续所有里程碑验证使用。

### 交付物
- 可启动的前后端服务。
- 基础健康检查接口（如 `/health`）。
- `fixtures/demo.json` 示例数据。

### 验收标准
- 本地可一键启动。
- 启动日志清晰，无阻塞错误。
- `fixtures/demo.json` 可被后端正确加载。

---

## Milestone 1：PPT 播放与控制 + 状态机骨架（1.5 天）

### 目标
实现"打开演示 + 翻页控制 + 当前页状态同步"，同时落地状态机核心骨架。

### 任务
- 按第 4 章规范实现状态机骨架：
  - `StateMachine` 类：`transition(state, event, payload) => { nextState, actions[] }`。
  - 顶层状态：`idle / presenting / paused / end`（M1 只需这 4 个，`qa / interrupted` 留给 M3-M5）。
  - `presenting` 子状态：`narrating / waiting_confirm / auto_advance`。
  - Guard 与幂等校验。
  - 每次状态迁移写入结构化日志（最小版：`console.log` 即可，M5 替换为持久化）。
- 实现 `POST /api/session/start`：创建会话，加载 `fixtures/demo.json`，初始化 `PageContext[]`。
- 实现 `POST /api/control`：`start / next / prev / goto / pause / resume / stop`。
- 实现 `GET /api/session/:id`：返回当前状态（含子状态）与 `pages[]` 摘要。
- 接入 Web-PPT 播放容器（前端）。
- 前后端联调翻页控制。

### 交付物
- 可运行的状态机（含单元测试覆盖核心转移规则）。
- 控制 API 可调用。
- 页面上可见当前页码与状态（含子状态）。

### 验收标准
- 连续翻页、边界页翻页、跳页都正确。
- 控制指令平均响应 < 500ms（本地）。
- 状态转移日志可在控制台中观察到。
- 非法事件（如 `idle` 下发 `NEXT`）被正确拒绝并返回错误提示。

---

## Milestone 2：讲解词与 TTS 播放（1 天）

### 目标
实现“每页讲解词播报 + 播报结束策略”。

### 任务
- 为页面绑定 `script`（静态配置即可）。
- 接入 TTS，支持播放/暂停/停止。
- 播报完成后根据策略：
  - 自动翻页；或
  - 等待用户确认。

### 交付物
- 讲解主链路跑通（进入页面自动播报）。
- 控制台可切换“自动翻页/手动翻页”。

### 验收标准
- 10 页连续讲解无异常中断。
- 用户可在播报中打断并恢复。

---

## Milestone 3：语音输入与意图识别（1 天）

### 目标
实现“语音 -> 文本 -> 命令/提问识别”。

### 任务
- 接入麦克风采集与 ASR。
- 实现意图识别（归一化目标见**第 1.1.5 节**）：
  - **命令类**：`start|next|prev|goto|pause|resume|stop` 的口语同义，以及 `goto` 的页码/「第一页/最后一页」等
  - **第 X 章**（**仅**当 `fixtures` 中提供 `chapters` 时）：解析为 `goto(章首页)`，否则不承诺为稳定控制（见**第 1.1.6 节**）
  - **问答类**：非命令命中时作为问题
- 命令**优先**执行，问答在允许态下进入 `qa`（第 4 章）。

### 交付物
- 语音命令可驱动翻页与控制。
- 识别文本在界面可见（调试用）。

### 验收标准
- 至少 4 类命令稳定触发。
- 识别失败有友好提示。

---

## Milestone 4：基于 PPT 的问答（1.5 天）

### 目标
实现“当前页优先”的 RAG 问答，并返回语音回答。

### 任务
- 构建页面级索引（`pageNo/title/content/script`；可检索语料与**第 1.1.3 节**一致）。
- 按页面 `scope` / 场级 `qaPolicy`（若数据已提供，见**第 1.1.3 节、第 4.12 节**）约束检索与回复。
- 检索策略（默认，可与 `qaPolicy` 结合）：
  - 先检索当前页；
  - 命中不足时扩展到全局页。
- 调用 LLM 生成答案，附带 `sourcePages`。
- 对答案调用 TTS 播放。

### 交付物
- `ask(question)` 接口可用。
- 返回结构包含：`answerText`, `sourcePages`, `confidence`（可选）。

### 验收标准
- 相关问题回答可用率 >= 80%（人工抽样）。
- 信息不足时明确“无法确认”。

---

## Milestone 5：日志持久化、降级完善与稳定性（1 天）

### 目标
将 M1 引入的 console.log 日志升级为持久化，完善降级策略，保证长时间演示稳定性，支持复盘。

### 任务
- 将状态迁移日志从 `console.log` 升级为结构化持久存储（JSON 文件或 DB）。
- 记录关键日志：
  - 翻页事件
  - 讲解开始/结束
  - 问题与回答
  - 错误与重试
- 完善超时与降级策略（ASR/LLM/TTS 不可用时的 `fallbackMode` 自动切换与恢复）。
- 实现会话日志导出接口（`GET /api/session/:id/logs`）。
- 长时间运行压力验证（模拟 30-60 分钟连续演示）。

### 交付物
- 单场会话日志可导出（JSON 格式）。
- 异常不会导致整体演示崩溃。
- 降级模式可自动进入和手动恢复。

### 验收标准
- 30-60 分钟持续演示稳定。
- 出错后可恢复到"手动翻页 + 文本回答"模式。
- 日志文件包含完整的状态迁移链路，可用于复盘。

## 6. AI 每步输出模板（强制）

AI 每完成一步都按以下格式输出：

```md
## Step X 完成
- 目标：<本步目标>
- 变更文件：
  - `path/a`
  - `path/b`
- 关键实现：
  - <1-3条>
- 验证方式：
  - 命令：`...`
  - 结果：<通过/失败 + 关键信息>
- 风险与待办：
  - <1-2条>
- 下一步：
  - <下一步任务>
```

## 7. AI 执行指令模板（可直接复制）

## 指令 A：按里程碑执行

```text
请按照 docs/ai-dev-plan.md 从 Milestone 0 开始执行。
要求：
1) 一次只做一个 Milestone；
2) 先实现最小可运行版本，再优化；
3) 每完成后按“AI 每步输出模板”汇报；
4) 若缺依赖或外部服务不可用，先提供 mock 实现并继续推进；
5) 不要跳过验证步骤。
```

## 指令 B：只实现某个里程碑

```text
请只实现 docs/ai-dev-plan.md 的 Milestone 3（语音输入与意图识别）。
要求：给出变更文件、运行验证、已知限制，不要修改无关模块。
```

## 指令 C：进入联调模式

```text
现在开始联调整体链路（播放 -> 讲解 -> 打断提问 -> 回答 -> 恢复讲解）。
请修复所有阻塞主流程的问题，并输出最小复现步骤与修复说明。
```

## 8. Definition of Done（MVP）

满足以下条件视为 MVP 完成：
- 可完成一场 10 页以上 PPT 自动讲解。
- 用户可通过语音完成翻页/暂停/继续等控制。
- 用户提问可得到与 PPT 相关回答，并有语音播报。
- 关键操作均有日志，异常可回退到可用模式。
- README 提供清晰启动与演示说明。

## 9. 后续增强（非 MVP）

- 多语言讲解与问答。
- 多文档联合检索。
- 演示分析看板（热问问题、页面停留、完成率）。
- 权限与多租户能力。
