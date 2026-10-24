# (( · )) DeskBeacon

让 AI 连接并使用你的电脑。

DeskBeacon 是一个开源、自托管的远程设备 MCP 服务。你可以通过 Claude、Codex、ChatGPT 等支持远程 MCP 和 OAuth 授权的 AI 客户端，操作已连接的电脑，并在本地终端中查看执行过程、检查结果或停止任务。

## 可以做什么

- **执行命令**：运行脚本、构建项目、执行测试，或启动开发服务器等后台任务。
- **处理文件**：浏览、搜索、读取和编辑文件，压缩与解压归档。
- **传输文件**：在 AI 和设备之间上传、下载文件；可用方式取决于 AI 客户端的支持。
- **排查问题**：检查网络连接、访问设备上的本地服务、查看系统和进程状态、获取截图。
- **连接多台设备**：通过同一个服务器管理多台电脑，为设备分别命名。

## 开始使用

只需完成三步：**部署一个服务器 → 在电脑上安装客户端 → 将服务器添加到 AI 客户端**。服务器只需部署一次；每台需要连接的电脑各安装一次客户端。

### 1. 部署服务器

准备好 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)和 GitHub 账号，然后点击：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FDeskBeacon)

1. 按页面提示登录并连接 GitHub，将项目复制到自己的账号。
2. 选择 Cloudflare 账号，确认仓库名称和服务名称。
3. 在 `MCP_AUTH_SECRET` 中设置你自己的授权密码。之后连接电脑和 AI 时，都使用这个密码。
4. 确认部署。Cloudflare 会创建所需资源并发布服务。[部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
5. 部署成功后，复制服务的 HTTPS 地址，例如 `https://deskbeacon.your-account.workers.dev`。

如果页面要求填写构建设置，请使用以下内容：

| 设置 | 填写内容 |
| --- | --- |
| 根目录 | 仓库根目录 `/` |
| 构建命令 | `pnpm --filter @deskbeacon/protocol build` |
| 部署命令 | `pnpm run deploy` |
| 构建环境变量 `NODE_VERSION` | `24` |
| 构建环境变量 `PNPM_VERSION` | `11.1.3` |

**已有实例升级前**，先在 Cloudflare Workers Builds 的构建环境变量中设置 `DESKBEACON_OAUTH_KV_ID` 为原有 KV Namespace ID，确保不会重新绑定到空 KV。新的 fork 无需设置：占位 ID 会在临时部署配置中自动省略，以便 Wrangler 自动创建 KV。根目录 `wrangler.jsonc` 始终保持不变。详见 [部署配置和环境变量覆盖](docs/deployment-config.md)。

构建版本设置可参考 [Cloudflare 构建环境说明](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。如果部署时没有出现密码输入框，可在该 Worker 的 **Settings → Variables and Secrets** 中新增名为 `MCP_AUTH_SECRET` 的 **Secret**，填入密码并保存部署，再连接设备。

后文以 `https://deskbeacon.your-account.workers.dev` 为例，请替换为你自己的地址。电脑配对使用这个地址，AI 客户端（ChatGPT、Claude 等）使用时末尾加上 `/mcp` 的地址。

<details>
<summary>手动部署</summary>

在本机安装 [Node.js 24 或更新版本](https://nodejs.org/)和 [pnpm 11](https://pnpm.io/installation)，然后执行：

```bash
git clone https://github.com/RavelloH/DeskBeacon.git
cd DeskBeacon
pnpm install --frozen-lockfile
pnpm --filter @deskbeacon/protocol build
pnpm --filter @deskbeacon/server exec wrangler login --config ../../wrangler.jsonc
# 如已创建 KV，先设 DESKBEACON_OAUTH_KV_ID；新部署不设置即可自动预配。
pnpm run deploy
```

在 Cloudflare Dashboard 的 **Settings → Variables and Secrets** 配置 `MCP_AUTH_SECRET`（Secret）。既有实例应在部署前设置构建环境变量 `DESKBEACON_OAUTH_KV_ID` 为原有 KV ID；无须再编辑任何 JSONC。部署完成后记下输出的 HTTPS 地址。

</details>

### 2. 安装并连接客户端

在需要让 AI 操作的电脑上安装 [Node.js 24 或更新版本](https://nodejs.org/)，再打开终端执行：

```bash
npm install -g deskbeacon
deskbeacon
```

配对时会打开浏览器。输入部署时设置的授权密码，完成设备授权；回到终端后，运行 `deskbeacon` 并等待界面显示已连接。

也可以直接运行 `npx deskbeacon`，首次启动时按提示输入服务器地址并完成授权。使用 npm 或 npx 安装客户端无需下载源码。

需要连接更多电脑时，在每台电脑上重复上述步骤，使用同一个服务器地址。保持电脑开机、联网，并让 DeskBeacon 运行，AI 才能访问该设备。不同系统的截图等功能受系统权限和运行环境影响。

### 3. 连接 AI 客户端

在支持远程 MCP（Streamable HTTP）和 OAuth 授权的 AI 客户端中，添加服务器：

```text
https://deskbeacon.your-account.workers.dev/mcp
```

按提示完成授权，输入相同的授权密码。连接成功后，可以直接对 AI 说：

> 列出我已连接的设备。
>
> 查看我的开发电脑上有哪些项目。
>
> 在这台电脑的项目目录中运行测试，并告诉我结果。
>
> 启动项目的开发服务器，再检查本地页面是否能访问。

如果有多台设备，请在请求中说明设备名称和目标目录。远程操作由 AI 发起，本地界面用于查看活动和停止任务。

## 日常使用

### 打开界面与后台运行

运行 `deskbeacon` 打开终端界面。常用操作如下，完整快捷键可在界面中按 `?` 查看：

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓` | 选择记录 |
| `Tab` | 切换活动、详情和后台任务区域 |
| `s` | 搜索活动 |
| `i` / `o` | 查看完整输入 / 输出 |
| `/` | 打开命令面板 |
| `x` | 停止选中的任务 |
| `q` | 退出界面 |

希望关闭终端后仍保持设备在线，可以启动后台服务：

```bash
deskbeacon service start
```

之后运行 `deskbeacon` 可随时查看活动；退出界面时，已启动的后台服务会继续运行。后台运行需先手动启动，不代表已设置开机自启。

```bash
deskbeacon status          # 查看设备状态
deskbeacon service restart # 重启后台服务
deskbeacon service stop    # 停止服务并断开设备
```

普通启动后用 `q` 正常退出会断开设备；若终端意外关闭，设备可能仍在线，可用 `deskbeacon status` 检查，并用 `deskbeacon service stop` 停止。

### 修改名称与服务器地址

设备连接后，可以为它设置容易辨认的名字：

```bash
deskbeacon config name "我的开发电脑"
```

更换服务器时，重新配对：

```bash
deskbeacon setup --url https://你的新服务器地址
```

### 无浏览器设备授权

SSH、无图形界面的 Linux 和远程 VPS 可以通过另一台设备的浏览器完成 OAuth 授权：

```bash
deskbeacon setup --device --url https://beacon.example.com
```

CLI 会显示一个短期验证码与 `https://beacon.example.com/activate` 地址。在手机或其他电脑打开该地址，输入验证码，核对目标设备名称，再使用已有的管理密钥确认授权。CLI 会自行轮询、使用 PKCE 交换 OAuth Token 并保存配置，目标设备无需监听端口。

通常在桌面环境中运行 `deskbeacon setup` 会使用已有的本地浏览器授权；SSH/无头 Linux 自动选择设备配对模式。也可显式指定 `--browser` 使用旧流程，或指定 `--device` 强制跨设备授权。

详细协议和安全设计参见 [无浏览器设备授权](docs/headless-pairing.md)。

### 代理设置

默认不启用应用层代理。可以在安装后的终端开启自动发现，或直接指定手动代理：

```bash
deskbeacon config proxy-auto true
deskbeacon config proxy-url http://127.0.0.1:7890
deskbeacon config proxy-url null
deskbeacon doctor
```

在 config.json 中，proxyAuto 为 boolean，proxyUrl 为 string 或 null。当手动代理地址非空时，它总是优先于自动发现；清除后由 `proxy-auto` 决定是否自动使用环境变量和当前用户的系统代理设置。TUI 也可以通过 `/config proxy-auto true`、`/config proxy-url ...` 修改。首次设备授权之前可临时设置环境变量 `DESKBEACON_PROXY_URL`，用于代理 OAuth 请求。Windows/macOS、Linux、Termux 支持范围和注意事项参见 [代理设置说明](docs/network-proxy.md)。

### 更新与排查

使用全局安装的客户端时，先退出界面并停止后台服务，再更新：

```bash
deskbeacon service stop
npm install -g deskbeacon@latest
deskbeacon
```

需要继续后台运行时，将最后一条命令换为 `deskbeacon service start`。使用 npx 时，可用 `npx deskbeacon@latest` 启动最新版。

服务器通过 Cloudflare 部署按钮创建后，可以在自己的仓库中同步上游更新，再到 Cloudflare 的构建页面重新部署。已有服务器升级时，请保留原来的地址、密码和已绑定资源。

遇到连接或运行问题时，先检查服务器地址、密码，以及设备是否在线，再运行：

```bash
deskbeacon doctor
deskbeacon service logs
deskbeacon help
```

DeskBeacon 使用运行客户端的系统账户权限执行操作。请妥善保管授权密码，仅授权你信任的 AI 客户端。
