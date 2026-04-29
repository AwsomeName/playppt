# playppt

基于 Web 的 PPT 讲解 Agent：浏览器里看幻灯片（PNG）、按页口播 TTS、语音/文本问答，**会话与翻页状态以后端状态机为唯一真源**，前端负责展示与控制面调用。

**架构与模块说明**见 `docs/project.md`（含当前代码布局与 API 摘要）；**里程碑与接口真源**见 `docs/ai-dev-plan.md`。

## 新环境：安装与启动

在一台从未配置过本项目的机器上，按顺序执行即可跑起本地开发环境。

**前置条件**

- 安装 [Node.js](https://nodejs.org/)（建议 **Current LTS**）与自带的 **npm**。
- 可选：Git，用于克隆仓库。

**步骤**

1. **获取代码**（二选一）  
   - `git clone <仓库地址> && cd play-ppt`  
   - 或解压源码包后进入项目根目录（与 `package.json` 同级）。

2. **安装依赖**（必须在仓库根目录执行，以安装 workspace 下 `apps/web`、`apps/server`）：

   ```bash
   npm install
   ```

3. **环境变量（推荐）**  
   复制示例文件并按需填写（密钥勿提交到 Git；`.env` 已在 `.gitignore` 中）：

   ```bash
   cp .env.example .env
   ```

   不接真实 AI 服务时，可在 `.env` 中设置 `AI_PROVIDER=mock` 先跑通主链路；接入火山等配置见下文「AI 服务配置」。  
   若你更习惯把密钥放在本机文件，可在项目根目录创建 **`local.properties`**（该文件已加入 `.gitignore`，勿提交），字段说明见下文「AI 服务配置」。

4. **启动开发服务**（根目录一条命令同时起前后端）：

   ```bash
   npm run dev
   ```

   - **前端**：<http://localhost:5173>（Vite；首页会请求后端 `/health` 展示状态）  
   - **后端**：<http://localhost:3001/health>（Express；含已加载的 `presentations/demo` 摘要）

5. **验证**  
   浏览器打开前端地址；若页面正常且健康检查有响应，说明安装与启动成功。

**仅单独启动某一端（可选）**

```bash
npm run dev -w apps/server   # 仅后端
npm run dev -w apps/web      # 仅前端
```

**生产构建与本地预览（可选）**

```bash
npm run build
npm run start -w apps/server   # 后端运行编译产物（需先 build）
npm run start -w apps/web      # 前端预览构建结果（默认端口见 apps/web）
```

## 构建与检查

在仓库根目录：

```bash
npm run lint
npm run test
npm run build
```

端到端（Playwright）在依赖已安装的前提下：

```bash
npx playwright install   # 首次在本机跑 E2E 时建议执行
npm run e2e
```

## 目录说明

- `apps/web`：前端（Vite + React + TypeScript + React Router）
  - `/`：`ManagePage`，选演示稿、创建会话、（可选）编辑口播与知识库
  - `/play/:sessionId`：`PlayPage`，放映幻灯片、播放控制、语音面板与问答
- `apps/server`：后端（Express + TypeScript）
  - `routes/api.ts`：REST API（会话、控制、口播 TTS、问答、语音等）
  - `domain/`：会话状态机、意图解析
  - `services/`：会话编排、演示稿文件、PPTX 转图、审计日志等
  - `ai/`：ASR / TTS / 问答管线（可按配置使用 mock、火山或 OpenAI）
- `presentations/<presentationId>/`：每个演示稿一个目录（示例为 `demo`，也可多个 ID 并存）
  - `manifest.json`：元数据与 `pages[]`（页码、标题、正文）
  - `scripts.json`：逐页口播；可选 `opening` / `closing`
  - `kb.json`：可选知识库（编辑口播时可用）
  - `deck.pptx`：源文件；可选由服务端转为 `slides/slide-*.png` 供前端展示
- `var/session-logs/`：会话 NDJSON 日志（默认路径，已在 `.gitignore`）
- `fixtures/demo.json`：旧版兼容 fixture（测试与回退用）

## AI 服务配置

默认 `AI_PROVIDER=volc`，服务端会优先读取 `.env`，缺失时再读本机 `local.properties` 中的火山云字段：

- `VOLC_APP_ID`
- `VOLC_ACCESS_TOKEN`
- `VOLC_SECRET_KEY`
- `VOLC_TTS_RESOURCE_ID`（默认 `seed-tts-2.0`，火山豆包大模型 TTS）
- `VOLC_TTS_SPEAKER`（默认 `zh_female_meilinvyou_saturn_bigtts`）
- `VOLC_ASR_RESOURCE_ID`

真实密钥不要写入文档或提交；如需临时绕过外部服务，可设 `AI_PROVIDER=mock`。

### 切换 TTS 音色

火山豆包大模型 TTS（`seed-tts-2.0`）有几十种内置音色，把 `VOLC_TTS_SPEAKER` 改成对应 ID 即可，无需重启前端，下一次合成自动生效。常用中文音色（按场景）：

| Speaker ID | 风格 | 备注 |
| --- | --- | --- |
| `zh_female_meilinvyou_saturn_bigtts` | 甜美女友 | 当前默认，亲切柔和 |
| `zh_female_qingxin_bigtts` | 清新女声 | 偏轻快、信息播报感 |
| `zh_female_wanwanxiaohe_bigtts` | 婉婉小荷 | 温润书卷气 |
| `zh_female_shuangkuaisisi_bigtts` | 爽快思思 | 节奏快、通勤播客感 |
| `zh_male_M392_conversation_wvae_bigtts` | 自然对话男声 | 适合讲解/培训 |
| `zh_male_chunhou_bigtts` | 醇厚男声 | 中年稳重、纪录片感 |
| `zh_male_wennuanahu_bigtts` | 温暖阿虎 | 暖男口播，偏年轻 |
| `zh_male_yuanboxiaoshu_bigtts` | 渊博小叔 | 解说/科普 |
| `zh_male_jingyangboshi_bigtts` | 静雅博士 | 学术、专业感 |

更多音色名见火山豆包大模型 TTS 控制台「音色市场」。如需让讲解听起来更自然，本项目已经做了**逐句切分 + 句间 280ms 停顿**：每页讲稿在服务端按中文标点切句，前端依次播放，省得整段一气呵成像背稿。

## 演示稿目录

每个演示稿一个目录：`presentations/<presentationId>/`。

- `manifest.json`：`presentationId`、`title`、`deckFile`、`totalPages`、`pages[]`（`pageNo/title/content`）。
- `scripts.json`：`scripts[]`（`pageNo/script`），TTS 和问答检索都会使用这里的解说词。
- `deck.pptx`：目标 PPT 文件。当前首版仅管理和暴露该文件，不解析 `.pptx` 内容；页面展示仍来自 `manifest.json`。

可用演示列表接口：`GET /api/presentations`。

## 批量生成口播（CLI）

在仓库根目录：

```bash
npm run gen-scripts -- --presentation=demo --dry-run
```

（根目录脚本已用 `--` 转发参数到 `apps/server`；若直接在工作区内跑：`npm run gen-scripts -w apps/server -- --presentation=demo`。）

常用参数：`--dry-run`（只打印 JSON）、`--merge`（保留已有非空口播，只补空页）。无 `OPENAI_API_KEY` 时用 `title+content` 模板生成。

## 网页编辑口播与知识库

设置 `PPT_PRESENTATION_EDITOR=true` 后，首页在会话区域会出现「演示稿编辑」面板，可写回 `scripts.json` 与 `kb.json`。保存后需**新建会话**才会加载新内容。

## 文档导航

- 产品文档：`docs/product.md`
- PRD：`docs/prd.md`
- 项目文档（技术与架构）：`docs/project.md`
- AI 开发执行计划（执行真源）：`docs/ai-dev-plan.md`（**整体架构、数据、控制命令、XState/测试**见第 **1.1** 节；**通过 MCP 操作浏览器仅允许** `@playwright/mcp` **官方包**，见 **1.1.9** 与**第 2 节**）
