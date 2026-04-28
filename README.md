# playppt

基于 Web-PPT 的 PPT 讲解 Agent 项目。

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

- `apps/web`：前端（Vite + React + TypeScript）
- `apps/server`：后端（Express + TypeScript）
- `presentations/demo`：示例演示目录，`manifest.json` 放目标 PPT 元数据与页面内容，`scripts.json` 放逐页解说词，`deck.pptx` 由使用者本地放入
- `fixtures/demo.json`：旧版兼容 fixture（测试与回退用）

## AI 服务配置

默认 `AI_PROVIDER=volc`，服务端会优先读取 `.env`，缺失时再读本机 `local.properties` 中的火山云字段：

- `VOLC_APP_ID`
- `VOLC_ACCESS_TOKEN`
- `VOLC_SECRET_KEY`
- `VOLC_TTS_RESOURCE_ID`
- `VOLC_TTS_SPEAKER`
- `VOLC_ASR_RESOURCE_ID`

真实密钥不要写入文档或提交；如需临时绕过外部服务，可设 `AI_PROVIDER=mock`。

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
