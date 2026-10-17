# (( · )) DeskBeacon

**面向单人自托管的 Agent ↔ Device 远程 MCP。当前版本：0.1.0 Alpha（未发布）。**

一个 Owner 可以授权多个 Agent 客户端（OAuth Grant），并在多台设备上运行 Node.js 客户端。所有设备操作均由 Agent MCP 工具调用发起；本地 Ink TUI 只观察、搜索历史及中断已有任务。

## Monorepo

```text
apps/server        Cloudflare Worker、OAuth、MCP、SQLite-backed Durable Object
apps/client        Node.js CLI、Daemon、IPC、Ink TUI、命令/文件/网络/系统工具
packages/protocol  34 个 MCP Tool Schemas、版本化设备协议、错误与限制
.agent/            开发架构、验收标准、状态和后续工作
```

服务器仅使用 **KV（OAuth/设备元数据）+ 每设备一个 SQLite DO**，无 D1/R2。DO 保存最近有界的前台文本结果和操作状态，不保存文件二进制。后台长时输出在设备本地 SQLite 元信息和本地输出文件内。

## 当前验证与限制

- 已在 Windows 11 + Node 24 上跑通：Owner 密码授权下的 Device/Agent OAuth，WebSocket 设备连接，MCP 初始化、工具注册和 Agent→Worker→DO→Node 执行。
- 已通过实际远程测试：单命令同步执行、前台结果 DO 历史查询、Batch、明确后台启动/读取/停止、文件读取和 ripgrep 内容搜索、ZIP 归档、内联小文件双向传输、HTTP/TCP、系统观测和截图；更多测试见 `.agent/12-tracking/testing.md`。
- 未完成的关键部分：**Windows Job Objects 原生进程树监管已完成基础实现和本地测试**（生产 NativeAOT 构建尚待 CI 验证）、DO 休眠成本与断线状态机压力测试、文件大流式上传/下载、Agent Host 附件适配、后台 PTY、各类分页/平台适配完整性、多 Agent/多设备隔离压测。
- MCP 工具注册达到 34 个不等于全部功能完整；部分参数和工具目前只具备 Alpha 能力。不能以此代码直接授权生产管理员设备。

## 本地构建

要求 Node.js 24、pnpm 11、Wrangler 4。

```powershell
cd E:\DeskBeacon
pnpm install
pnpm check
pnpm test
pnpm build
```

- `pnpm --filter @deskbeacon/server dev`：启动 Cloudflare Worker 本地环境。
- `pnpm --filter @deskbeacon/protocol build`：构建共享协议。
- `pnpm --filter deskbeacon build`：构建 CLI。
- `node apps/client/dist/index.js doctor`：本机诊断。

### Worker 配置

`apps/server/wrangler.jsonc` 里的 KV namespace ID 是**占位符**，正式部署前须替换自己的 KV ID 并按需配置 Worker/DO。设置 `OWNER_LOGIN`、`PUBLIC_BASE_URL`，并以 Wrangler Secret 设置 `OWNER_PASSWORD_HASH`（格式 `pbkdf2-sha256$<iterations>$<salt-b64url>$<hash-b64url>`）和 32 字符以上的 `OWNER_SESSION_SECRET`。

本地临时测试用 `node scripts/setup-dev.mjs` 生成 `apps/server/.dev.vars`。**它使用固定、公开的仅供本机集成测试的密码，绝不可复制到任何公网部署。**

### 本地配对和运行

服务端配置就绪后，在设备终端运行：

```powershell
node apps/client/dist/index.js setup --url http://localhost:8787
node apps/client/dist/index.js start
node apps/client/dist/index.js tui
```

首次 setup 通过 OAuth 浏览器授权获取独立 Device Grant；`start` 在本机启动 Daemon，`tui` 附加 UI。其他命令：`status`、`doctor`、`stop`。CLI npm bin 计划为 `deskbeacon`，但**尚未发布 npm，因此现在不能假设 `npx deskbeacon` 可用**。

独立 Agent 使用 OAuth 授权的 MCP Streamable HTTP URL：`https://<部署地址>/mcp`，scope `deskbeacon:agent`。设备使用 `deskbeacon:device` 授权连接。令牌与设备的密钥不要存入 Git 或日志。

### 本地 E2E（仅供开发）

先在本地配置测试密钥，并启动 Wrangler localhost:8787。使用：

```powershell
$env:DESKBEACON_DATA_DIR = 'E:\DeskBeacon\.test-data'
node apps/server/test/local-oauth-e2e.mjs
node apps/client/test/ipc.mjs
node apps/client/test/supervisor.mjs
```

E2E 测试在本机注册新的测试 Grant、连接测试设备，并执行非破坏性测试命令。默认本地测试凭据仅用于隔离的开发环境。勿对公网生产实例运行这个脚本。

## 约束与安全

- 不添加 MCP 端逐次人工审批，保留 TUI 本地停止能力；Agent 授权等于远程执行 Daemon 所属 OS 账户权限的命令。
- 同一设备只允许一个前台 Operation 运行；Batch 内可并行。前台 MCP 始终等待结束，不自动转后台。
- 不提供设备间相互传文件、主动外部 URL 文件同步或 TUI 发起远程工作；Agent↔Device 内联文件传输已试验，大文件通道未完成。
- Worker 对明文控制指令可见；WSS 不等于端到端加密。限制 OS 用户权限、审慎授予 Agent Grant。
- TUI 的原始日志可能带敏感信息；不要将本地输出目录公开上传。

后续实现与验收入口：`.agent/12-tracking/status.md`、`tasks.md`、`testing.md`、`open-questions.md`。

### Reliability tests (local only)

- `pnpm test:local` runs the Node supervisor/IPC tests with isolated `.test-data`.
- `pnpm test:e2e` requires an explicitly running local Wrangler server at `http://localhost:8787` with the temporary local OAuth test credentials. It verifies OAuth/MCP execution, multi-Agent serial foreground calls, idempotency conflicts and WebSocket fault recovery. **Do not run this against a production account.**

## Windows 原生进程监管（v0.1 Alpha）

Windows 前台/后台命令统一经过独立的 Win32 Job Object 启动器。Native launcher 在子进程尚未运行时使用 `CREATE_SUSPENDED` 创建它，先调用 `AssignProcessToJobObject`，再 `ResumeThread`；Job 设置 `KILL_ON_JOB_CLOSE`，最多允许同一个受管任务内 128 个活跃进程。超时或取消通过终止 Job launcher 回收进程树；Node Daemon 如果被强行终止，launcher 检测到原始父进程退出，也会关闭 Job 并回收子孙进程。Windows 命令包括 `node`、`pnpm.cmd` 和 PowerShell 都已通过本地测试。

普通 Windows 用户不应被要求安装 .NET。项目新增 `apps/client/native/win-job` C# 源码和 `.github/workflows/windows-native.yml`，由 Windows GitHub Actions 的 Visual C++ 编译环境生成 **win-x64 NativeAOT** 自包含可执行文件。发布前必须通过 `apps/client/scripts/verify-native.mjs` 校验，否则禁止打包。当前开发机没有 NativeAOT 需要的 VC++ 链接器，所以本机验证的是 framework-dependent 测试编译，不是正式可发布二进制；**CI 尚未远程执行，npm 未发布**。Windows ARM64 原生支持与 WSL 内 Linux 进程树监管仍未验收。

## CLI 独立 npm 打包

`apps/client/scripts/stage-npm.mjs win-x64` 使用 esbuild 将共享 workspace 协议直接打入 CLI，生成不依赖未发布 `@deskbeacon/protocol` 的 npm 包，包含 CLI、MIT LICENSE、README 与 NativeAOT 启动器。CI 再执行 `npm pack apps/client/dist/npm` 生成发布候选 tarball。无 NativeAOT 时只可用 `--local-smoke` 生成标记为 `private: true` 的不可发布本地测试包。

未来 npm 正式发布后可直接运行 `npx deskbeacon`：首次启动在终端询问自己的 Worker URL，进入浏览器 OAuth 配对，然后连接 Daemon 并打开 Ink TUI。当前仍可用 `node apps/client/dist/index.js` 在本地开发验证。

## DO 低唤醒策略

设备 Node 客户端每 60 秒发送 `ping` 文本；每设备 DO 通过 Cloudflare `setWebSocketAutoResponse("ping", "pong")` 自动回答，而不是启动完整对象处理器。已通过本地 WSS ping/pong 测试；不代表已经获得 Cloudflare 生产环境的费用或 Duration 数据。Worker 的自动可观测性记录已默认关闭，持久存储仍限 KV 和 SQLite DO，不增加 D1/R2。
