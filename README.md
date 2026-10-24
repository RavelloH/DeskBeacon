# (( · )) DeskBeacon

让 AI 连接并使用你的电脑。

DeskBeacon 是一个开源、自托管的远程设备 MCP 服务。连接后，你可以在 ChatGPT、Claude、Codex 等支持 MCP 的 AI 客户端中，让 AI 在已授权的设备上执行操作。

## 可以做什么

- **执行命令**：运行脚本、构建项目、启动或停止后台任务。
- **处理文件**：查看、搜索、编辑文件，压缩或解压。
- **传输文件**：在 AI 客户端与设备之间传输文件。
- **查看设备状态**：检查进程、网络、运行状况，并在受支持的平台上截图。
- **管理多台设备**：通过一个服务器连接多台电脑，分别为它们命名。

## 快速开始

### 1. 部署服务器

准备 Cloudflare 和 GitHub 账号，点击：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FDeskBeacon)

按照页面提示复制仓库、选择 Cloudflare 账号，并设置自己的授权密码 `MCP_AUTH_SECRET`。

如果需要填写构建设置，请使用：

| 设置 | 值 |
| --- | --- |
| 根目录 | `/` |
| 构建命令 | `pnpm build` |
| 部署命令 | `pnpm deploy` |
| `NODE_VERSION` | `24` |
| `PNPM_VERSION` | `11.1.3` |

部署后记下服务器地址，例如 `https://deskbeacon.your-account.workers.dev`。

也可以在自己的电脑上手动部署：

```bash
git clone https://github.com/RavelloH/DeskBeacon.git
cd DeskBeacon
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @deskbeacon/server exec wrangler login
pnpm deploy
```

### 2. 连接电脑

安装 [Node.js 24 或更新版本](https://nodejs.org/)，然后运行：

```bash
npm install -g deskbeacon
deskbeacon
```

首次启动时填入自己的服务器地址，并按提示在浏览器中使用授权密码完成配对。连接其他电脑时，重复相同的步骤。

你也可以使用 `npx deskbeacon`，无需全局安装。

如果电脑没有浏览器（如 SSH 终端或 VPS），在该设备上运行：

```bash
deskbeacon setup --device --url https://你的服务器地址
```

然后在手机或其他电脑上打开终端显示的地址，输入验证码并确认授权。

### 3. 连接 AI 客户端

在支持远程 MCP 的 AI 客户端中添加：

```text
https://deskbeacon.your-account.workers.dev/mcp
```

按提示授权后，就可以让 AI 查看已连接的设备或执行操作。如果连接了多台电脑，请在请求中明确指定目标设备。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `deskbeacon` | 打开终端界面并连接设备 |
| `deskbeacon setup --url <服务器地址>` | 更换服务器或重新配对 |
| `deskbeacon status` | 查看连接状态 |
| `deskbeacon config name "我的电脑"` | 修改设备名称 |
| `deskbeacon service start` | 在后台运行 |
| `deskbeacon service stop` | 停止后台服务 |
| `deskbeacon service restart` | 重启后台服务 |
| `deskbeacon config proxy-auto true` | 自动发现系统代理 |
| `deskbeacon config proxy-url http://127.0.0.1:7890` | 手动指定代理 |
| `deskbeacon config proxy-url null` | 清除手动代理 |
| `deskbeacon doctor` | 检查运行环境 |
| `deskbeacon service logs` | 查看客户端日志 |
| `deskbeacon help` | 查看完整帮助 |

后台服务不会自动设置开机启动。需要 AI 随时连接设备时，请确保设备已开机、联网且 DeskBeacon 正在运行。

## 终端界面

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓` | 选择记录 |
| `Tab` | 切换活动、详情和后台任务 |
| `s` | 搜索活动 |
| `i` / `o` | 查看完整输入 / 输出 |
| `/` | 打开命令面板 |
| `x` | 停止选中的任务 |
| `?` | 查看快捷键 |
| `q` | 退出界面 |

## 更新与排查

```bash
deskbeacon service stop
npm install -g deskbeacon@latest
deskbeacon
```

如果设备无法连接，先确认服务器地址、网络和后台服务状态，再运行 `deskbeacon doctor`。

DeskBeacon 使用运行客户端的系统账户权限执行操作。请妥善保管授权密码，仅授权你信任的 AI 客户端。
