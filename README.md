# playppt

基于 Web 的 PPT 讲解 Agent：浏览器里看幻灯片（PNG）、按页口播 TTS、语音/文本问答，**会话与翻页状态以后端状态机为唯一真源**，前端负责展示与控制面调用。

**架构与模块说明**见 `docs/project.md`（含当前代码布局与 API 摘要）；**里程碑与接口真源**见 `docs/ai-dev-plan.md`。

## 界面预览

**放映页 `/play/:sessionId`**：左侧幻灯片 + 底部控制条（上一页 / 下一页 / 暂停 / 结束 / 手动·自动 / 倍速 / 提问），右侧实时面板显示当前 FSM 子状态（如 `presenting/narrating`）、倒计时与对话/语音输入。

![放映页：幻灯片 + 控制条 + 实时聊天面板](docs/截图2.png)

**管理页 `/`**：选演示稿、配置 TTS 音色与音色资源；当 `PPT_PRESENTATION_EDITOR=true` 时还会出现「编辑：&lt;presentationId&gt;」面板，可直接修改 `scripts.json`（口播开/收场白 + 逐页讲稿）与 `kb.json`（chunks 知识库），保存后**新建会话**生效。详见下文「网页编辑口播与知识库」。

![管理页：演示稿列表 + 口播 / 知识库编辑器](docs/截图1.png)

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
   有两份示例文件，按需选用，**两者字段一致；环境变量优先级：`process.env` / `.env` > `local.properties`**：

   ```bash
   cp .env.example .env                       # 跨平台、构建/CI 推荐
   cp local.properties.example local.properties  # 本机长期保管密钥；已在 .gitignore 中，不会被提交
   ```

   不接真实 AI 服务时，可在 `.env` 中设置 `AI_PROVIDER=mock` 先跑通主链路；接入火山等配置见下文「AI 服务配置」。

4. **启动开发服务**（根目录一条命令同时起前后端）：

   ```bash
   npm run dev
   ```

   - **前端**：<http://localhost:35172>（Vite；首页会请求后端 `/health` 展示状态）  
   - **后端**：<http://localhost:3001/health>（Express；含已加载的 `presentations/demo` 摘要）

   > 端口可改：前端在 `apps/web/vite.config.ts`（`server.port` / `preview.port`）与 `apps/web/package.json` 的 `start`；后端通过环境变量 `PORT`（默认 `3001`）。前端在开发与预览时都会把 `/api`、`/health` 代理到 `VITE_API_BASE`（默认 `http://localhost:3001`）。

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
npm run start:prod    # 同时常驻后端 dist + 前端 vite preview（35172），适合本机长期使用
# 或分别启动：
npm run start -w apps/server   # 后端运行编译产物（需先 build）
npm run start -w apps/web      # 前端预览构建结果（35172；已将 /api、/health 代理到 3001）
```

## 部署：本机后台长期运行

下面两条路线分别给 **macOS** 与 **Linux**，目标一致：服务挂掉自动重启、登录后自动拉起；**不要用 `npm run dev` 做长期生产常驻**（默认走 `npm run start:prod`，要先 `npm run build`）。

### Linux：systemd 用户服务（推荐）

仓库内 `scripts/linux/install-systemd-user.sh` 会写一个用户级 `~/.config/systemd/user/playppt.service` 并注册启动。

```bash
# 0) 先安装依赖（首次）
npm install

# 1) 生产模式（默认）：先 build，再用 npm run start:prod 常驻
npm run install:systemd-user

# 1) 开发模式（可选）：直接托管 npm run dev，跳过 build
npm run install:systemd-user -- --dev

# 自定义单元名（默认 playppt）
npm run install:systemd-user -- --unit-name playppt-stage
```

常用命令（默认单元名 `playppt`）：

```bash
systemctl --user status playppt          # 状态
systemctl --user restart playppt         # 重启
systemctl --user stop playppt            # 停止
systemctl --user disable playppt         # 取消登录自启
journalctl --user -u playppt -f          # 跟随日志
```

> **注销/无图形会话也想保持运行**：执行一次 `sudo loginctl enable-linger "$USER"`，否则用户级 systemd 会随会话关闭而停止。  
> **更新代码后**：生产模式需 `npm run build && systemctl --user restart playppt`；开发模式（`tsx watch` + Vite）一般会自动热重载。  
> **端口冲突**：脚本启动前会尝试释放本机 `35172` 与 `3001`；若被其它服务占用，请先调整端口（见上文「端口可改」）。

### macOS：LaunchAgent（登录自启）

**这条路线在 macOS 上是官方支持的**（用户级 `LaunchAgents` + `launchctl bootstrap`）。

1. 先 **`npm install && npm run build`**，再在仓库根执行：

   ```bash
   npm run install:launchagent-mac
   # 等价于：bash scripts/macos/install-launchagent.sh
   ```

   脚本会把 `scripts/macos/launchd/com.playppt.app.plist.example` 里的路径填成你本机目录 → 写入 `~/Library/LaunchAgents/com.playppt.app.plist` → 用 `launchctl bootstrap` 注册。之后**每次登录该用户**都会跑 `npm run start:prod`（`RunAtLoad` + `KeepAlive`）。

   - 重拉一次：`launchctl kickstart -k gui/$(id -u)/com.playppt.app`
   - 卸载：`launchctl bootout gui/$(id -u)/com.playppt.app`

   为避免与 **Cursor 等对 `localhost:3001` 的端口转发** 抢端口，plist 内默认 `PORT=3002` 且 `VITE_API_BASE=http://127.0.0.1:3002`（前端仍通过 35172 代理 `/api`）。直连健康检查：<http://127.0.0.1:3002/health>。

   若 Node/npm 来自 **nvm / fnm**，可能找不到 `npm`：请编辑生成的 plist，把 `ProgramArguments` 改成带 `source ~/.zshrc`（或你的配置）的一行。

### 通用注意事项

- **会话仅存内存**：整机重启或 node 进程被结束后，已开的会话会清空；演示稿 / 口播 / 知识库这类磁盘文件不受影响。
- **更新代码**：生产模式记得 `npm run build` 再重启服务；不 build 直接重启会跑旧的 `dist/`。
- **端口冲突**：35172（Web）与 3001（API）若被占用，可改环境变量 `PORT` 与 `VITE_API_BASE`，并同步 `apps/web/vite.config.ts` 的端口。

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
- `presentations/<presentationId>/`：每个演示稿一个目录
  - **仅 `presentations/demo` 入版本库**（演示稿基线）；用户上传的其它目录已通过 `.gitignore` 排除，不会进 Git
  - `manifest.json`：元数据与 `pages[]`（页码、标题、正文）
  - `scripts.json`：逐页口播；可选 `opening` / `closing`
  - `kb.json`：可选知识库（编辑口播时可用）
  - `deck.pptx`：源文件；可选由服务端转为 `slides/slide-*.png` 供前端展示
- `scripts/linux/`：Linux systemd 用户服务安装脚本（`npm run install:systemd-user`）
- `scripts/macos/`：macOS LaunchAgent 安装脚本（`npm run install:launchagent-mac`）
- `var/session-logs/`：会话 NDJSON 日志（默认路径，已在 `.gitignore`）
- `fixtures/demo.json`：旧版兼容 fixture（测试与回退用）

## AI 服务配置

默认 `AI_PROVIDER=volc`，服务端读取顺序：**`process.env` / `.env`** → **`local.properties`** → 代码内默认值。两份示例文件分别是：

- `.env.example`：跨平台、构建/CI 通用，复制为 `.env`
- `local.properties.example`：本机长期保管密钥，复制为 `local.properties`（已在 `.gitignore`）

最少需要的火山云字段：

- `VOLC_APP_ID`
- `VOLC_ACCESS_TOKEN`
- `VOLC_SECRET_KEY`
- `VOLC_TTS_RESOURCE_ID`（默认 `seed-tts-2.0`，火山豆包大模型 TTS）
- `VOLC_TTS_SPEAKER`（默认 `zh_female_meilinvyou_uranus_bigtts`；`seed-tts-2.0` 仅认 `*_uranus_bigtts` 后缀）
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
