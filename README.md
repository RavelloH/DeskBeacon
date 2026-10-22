# (( · )) DeskBeacon

DeskBeacon 是一个开源、自托管的远程设备 MCP 服务，让 AI Agent 能够通过标准 MCP 工具连接并操作你授权的电脑。

你可以在多台设备上运行 DeskBeacon，并通过 Claude、Codex、ChatGPT 等支持 MCP 的 Agent 执行开发和日常操作。所有远程操作均由 Agent 发起；设备上的终端界面用于查看活动、检查输出和停止任务。

## 功能

- **远程命令执行**：支持不同 Shell、同步前台命令、批量执行和明确启动的后台任务。
- **文件管理与搜索**：浏览、读取、编辑文件，搜索文件名和内容，以及压缩和解压归档。
- **文件传输**：由 Agent 向设备上传文件或从设备获取文件；当前适合小文件传输。
- **网络工具**：发起 HTTP 请求，检查连接状态和常见网络问题。
- **系统观测**：查看系统与进程信息、资源使用情况，并获取屏幕截图。
- **本地终端界面**：活动表格与详情双栏，按终端宽高自动左右或上下排列；支持搜索、分级斜杠命令候选、完整输入/输出分页、复制当前视图与本地停止任务。
- **多设备与 OAuth 授权**：使用自己的 Cloudflare 服务连接多台设备，并分别授权 Agent 和设备。

## MCP 工具

DeskBeacon 当前提供 **35 个 MCP 工具**，按功能划分如下。完整参数和输入 Schema 可通过 MCP `tools/list` 获取。

| 类别 | MCP 工具 |
| --- | --- |
| 设备与工作区 | `device_list`、`device_info`、`workspace_open`、`workspace_info`、`workspace_cd` |
| 文件与归档 | `fs_list`、`fs_stat`、`fs_read`、`fs_read_many`、`fs_find`、`fs_grep`、`fs_write`、`fs_edit`、`fs_manage`、`fs_archive` |
| 命令与批处理 | `exec_foreground`、`batch`、`exec_background` |
| 后台任务 | `background_list`、`background_get`、`background_output`、`background_input`、`background_stop` |
| 操作历史 | `operation_get`、`operation_output` |
| 文件传输 | `transfer_upload`、`transfer_download`、`transfer_status`、`transfer_cancel` |
| 网络诊断 | `net_ports`、`net_probe`、`http_request` |
| 系统观测 | `system_snapshot`、`system_processes`、`screen_capture` |

`batch` 支持在同一设备上组合多个工具：最多 6 个阶段、每阶段 6 次调用、总计最多 16 次调用。阶段按顺序执行，同一并行阶段内可包含前台命令；所有 Agent 的普通前台命令与 Batch 子命令共享设备本地 **4 槽位 FIFO 执行池**，Batch 本身不占槽位。文件/网络/系统工具不占用命令槽位。队列最多等待 60 秒，等待中也可以取消，且不会消耗命令运行超时。批处理不会自动回滚，也不支持跨设备操作或自动传递上一步的输出。Batch 子命令返回有界文本预览，完整本地进程输出留在设备上；包含 DO 历史查询或超大请求的 Batch 会回退到服务器分阶段编排。

## 部署

### 准备工作

需要 Cloudflare 账号、Node.js 24 或更新版本，以及 pnpm 11。

获取本仓库源码后，在项目根目录安装依赖并构建：

```bash
pnpm install
pnpm build
```

### 1. 部署 Cloudflare 服务端

进入服务端目录并登录 Cloudflare：

```bash
cd apps/server
pnpm exec wrangler login
pnpm exec wrangler kv namespace create OAUTH_KV
```

将命令返回的 KV Namespace ID 填入 `apps/server/wrangler.jsonc` 中 `OAUTH_KV` 的 `id` 字段。

设置 OAuth 授权密码：

```bash
pnpm exec wrangler secret put MCP_AUTH_SECRET
```

在提示时直接输入你自己的密码，后续 OAUTH 验证的时候需要使用这个密码来进行登录。

如需使用自定义域名，可将 `wrangler.jsonc` 中的 `MCP_BASE_URL` 设置为公开访问地址；否则保持空字符串即可。

部署服务：

```bash
pnpm exec wrangler deploy
```

部署完成后，记下 Worker 的 HTTPS 地址，后续设备和 Agent 都会使用它。

### 2. 安装并连接设备

在需要远程控制的电脑上安装客户端。**npm 分发包不需要 pnpm、.NET SDK 或源码仓库**；要求 Node.js 24 或更新版本。从 `0.2.0` 开始，`@deskbeacon/win32-x64` / `@deskbeacon/win32-arm64` 会按平台安装原生辅助程序；`0.1.0` 是旧版一体式 NativeAOT 包。

通过 npm 安装：

```bash
npm install -g deskbeacon
deskbeacon setup --url https://your-worker.example
deskbeacon
```

也可以直接运行 `npx deskbeacon`，无需全局安装。首次运行时，如果未配置 Worker，CLI 会提示配对地址。浏览器会打开 OAuth 授权页面，输入之前设置的 `MCP_AUTH_SECRET` 完成设备授权。

如果希望从源码运行，在仓库根目录执行：

```bash
pnpm install
pnpm --filter @deskbeacon/protocol build
pnpm --filter deskbeacon build
```

Windows 命令执行使用独立的 C / Win32 Job Object 辅助程序，不需要 .NET。Windows x64 与 ARM64 的平台 npm 包通过 `optionalDependencies` 按架构安装。源码构建需要 LLVM-mingw 交叉编译工具链（支持在同一 runner 生成两种架构），或 x64 本机的兼容 MinGW 编译器：

```bash
pnpm --filter deskbeacon build:native:win-x64
# 需要 ARM64 时：pnpm --filter deskbeacon build:native:win-arm64
node apps/client/dist/index.js setup --url https://your-worker.example
node apps/client/dist/index.js
```

你可以使用 status 查看设备状态；要停止后台服务，请使用 service stop。


也可以省略 setup 的 --url，客户端会交互式询问服务端地址。首次直接执行根命令时，如未配置，也会自动进入配对流程。

如果不希望一直打开终端界面，可以显式启动后台服务：

```bash
node apps/client/dist/index.js service start
node apps/client/dist/index.js service status
node apps/client/dist/index.js service logs
node apps/client/dist/index.js service stop
```

后台服务运行时，根命令只打开 TUI，不会创建第二条设备连接，退出 TUI 也不会停止已有服务。未运行后台服务时，根命令会启动独立 Supervisor 和 Runtime，再打开 TUI；正常使用 `q`、`/quit` 或连续两次 Ctrl+C 退出时，会停止本次创建的 Runtime。若 TUI 进程意外退出或被强制终止，Supervisor 将继续维持设备在线；重新运行 `deskbeacon` 可恢复界面，也可用 `deskbeacon service stop` 断开。

0.2.0 的后台服务新增独立监督进程：若 Runtime 意外崩溃，会记录错误并自动重启、恢复本地 IPC 和设备连接；执行 `service stop` 则会同时正常停止监督进程，不会意外拉起。诊断日志使用 rlog-js，按七个领域写入 `.deskbeacon/logs/*.jsonl` 并独立轮转；可运行 `deskbeacon service logs [service|runtime|connection|execution|migration|security|tui]` 查看。TUI 在本地 IPC 断开时会持续显示断开原因和恢复状态，成功重连后自动清除。

其他常用命令有 help、version、doctor 和 update。

终端界面中，`↑↓` 选择记录，`Tab` 切换活动、详情和后台任务；`s` 搜索活动，`/` 打开带左右分栏说明的命令候选面板。候选支持 `↑↓` 选择、空格逐级进入参数、回车执行和 Esc 关闭。`i` 查看完整输入参数，`o` 查看完整输出或结构化结果，`e` 切换 stdout/stderr，`c` 复制当前详情，`[` / `]` 翻页，`r` 刷新；`x` 停止选中进程，`X` 停止全部受管进程（本地确认），`f` 跟随最新活动，`q` 退出，`?` 查看帮助。TUI 支持 `/config name [value]` 与 `/config url [value]` 查询/设置设备名称或服务器地址；更换 URL 需重新 OAuth 授权后生效，CLI 不再提供 `rename` 命令。

顶栏左侧显示 DeskBeacon，右侧显示连接状态与延迟；背景和前景会随连接状态保持绿、黄、红三种原有配色。宽终端底栏左右两侧共用蓝底白字，窄终端上下显示帮助提示和精简状态。底栏每秒刷新 CPU、整机可用/总内存、操作数和运行时间。

### 3. 连接 AI Agent

在支持 **MCP Streamable HTTP 和 OAuth** 的 Agent 客户端中添加远程 MCP 服务器：

```text
https://your-worker.example/mcp
```

按照客户端提示打开 OAuth 授权页面，输入相同的授权密码，完成 Agent 授权。

#### OAuth 资源与旧设备兼容

从 2026-10-18 起，MCP Agent 使用 `https://your-worker.example/mcp` 作为独立 OAuth 资源（RFC 8707）；设备端继续使用部署 Origin 作为兼容资源，不改变已有 Client/Grant/Refresh Token。原有 KV Namespace、Durable Object、Secret、域名、Worker 和环境变量都不需要重新创建。

- 已配对的设备不需要重新配对，旧客户端可以继续不发送 `resource`；新版本 setup 会明确请求 Origin。
- 已授权的旧 Agent 令牌只绑定 Origin，因此升级服务端后，Agent 可能需要删除旧 OAuth 授权缓存并重新授权一次；不要删除设备配对信息或清空 KV。
- OAuth 受保护资源元数据：Agent 使用 `/.well-known/oauth-protected-resource/mcp`；设备使用 `/.well-known/oauth-protected-resource`。
- 部署不增加环境变量。若之前配置过 `MCP_BASE_URL`，请保持原来的公开域名 Origin。已开启 `global_fetch_strictly_public` 用于支持 CIMD 客户端。
- 升级部署前建议备份 KV，回滚时也应保留原 Namespace。旧设备授权有效性的本地 E2E 已通过，但仍应在生产环境进行一次设备刷新和 Agent 重授权冒烟验证。

连接成功后，Agent 即可使用 DeskBeacon 的设备管理、命令执行、文件操作和系统工具。远程命令以设备上运行 DeskBeacon 的系统用户权限执行，建议使用专门的非管理员账户。
