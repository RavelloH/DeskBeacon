# (( · )) DeskBeacon

DeskBeacon 是一个开源、自托管的远程设备 MCP 服务，让 AI Agent 能够通过标准 MCP 工具连接并操作你授权的电脑。

你可以在多台设备上运行 DeskBeacon，并通过 Claude、Codex、ChatGPT 等支持 MCP 的 Agent 执行开发和日常操作。所有远程操作均由 Agent 发起；设备上的终端界面用于查看活动、检查输出和停止任务。

## 功能

- **远程命令执行**：支持不同 Shell、同步前台命令、批量执行和明确启动的后台任务。
- **文件管理与搜索**：浏览、读取、编辑文件，搜索文件名和内容，以及压缩和解压归档。
- **文件传输**：由 Agent 向设备上传文件或从设备获取文件；当前适合小文件传输。
- **网络工具**：发起 HTTP 请求，检查连接状态和常见网络问题。
- **系统观测**：查看系统与进程信息、资源使用情况，并获取屏幕截图。
- **本地终端界面**：查看 Agent 操作历史、命令输出与后台任务，必要时手动停止运行中的任务。
- **多设备与 OAuth 授权**：使用自己的 Cloudflare 服务连接多台设备，并分别授权 Agent 和设备。

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

在需要远程控制的电脑上安装项目客户端。当前 npm 包尚未正式发布，可以从源码运行。

在项目根目录执行：

```bash
pnpm install
pnpm --filter @deskbeacon/protocol build
pnpm --filter deskbeacon build
```

Windows 从源码运行还需要 .NET 10 SDK 和 Visual Studio C++ Build Tools，用于构建随客户端使用的本地运行组件：

```bash
pnpm --filter deskbeacon build:native:win-x64
```

完成后，配对设备（将地址替换为你的 Worker 地址）：

```bash
node apps/client/dist/index.js setup --url https://your-worker.example
```

浏览器会打开 OAuth 授权页面。输入之前设置的 `MCP_AUTH_SECRET`，完成设备授权。

启动客户端并打开本地终端界面：

```bash
node apps/client/dist/index.js start
node apps/client/dist/index.js tui
```

也可以使用 `status` 查看连接状态、使用 `stop` 停止客户端。在其他电脑上重复上述步骤即可添加设备。

### 3. 连接 AI Agent

在支持 **MCP Streamable HTTP 和 OAuth** 的 Agent 客户端中添加远程 MCP 服务器：

```text
https://your-worker.example/mcp
```

按照客户端提示打开 OAuth 授权页面，输入相同的授权密码，完成 Agent 授权。

连接成功后，Agent 即可使用 DeskBeacon 的设备管理、命令执行、文件操作和系统工具。远程命令以设备上运行 DeskBeacon 的系统用户权限执行，建议使用专门的非管理员账户。
