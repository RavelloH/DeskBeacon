# DeskBeacon 出站代理配置

桌面客户端、后台 Runtime 和配对流程使用同一个出站 HTTP/WebSocket 网络模块（`apps/client/src/outbound-network.ts`）。网络层可在每次新连接时重新选择代理，不修改操作系统代理设置。

## 配置

配置保存在 `~/.deskbeacon/config.json`（或 `DESKBEACON_DATA_DIR/config.json`）：

```json
{
  "proxyAuto": true,
  "proxyUrl": null
}
```

CLI 和 TUI 的斜杠命令：

```text
deskbeacon config proxy-auto true
deskbeacon config proxy-auto false
deskbeacon config proxy-url http://127.0.0.1:7890
deskbeacon config proxy-url socks5://127.0.0.1:1080
deskbeacon config proxy-url null
deskbeacon doctor
```

`proxyUrl` 为字符串且非空时始终优先使用指定代理，不调用自动发现；即使 `proxyAuto=off` 也会生效。`proxyUrl=null` 且 `proxyAuto=true` 时按环境变量、系统配置依次尝试，均无代理则直连。两者均未启用时直连，默认不改变原有网络行为。持久化字段分别为 boolean 和 string|null；CLI 用 true/false 和 null 字面量，拒绝 on/off/none 等别名。

手动代理支持 HTTP、HTTPS、SOCKS4/5 和 pac+http(s)。手动代理会作用于包括 localhost 在内的出站 HTTP 请求；自动代理则自动绕过 localhost/127.0.0.1/::1。用户名、密码只存本地配置，不打印在 doctor 或配置查询中，配置文件权限保持与设备令牌配置一致。

首次配对前还没有 config.json，可临时设置 `DESKBEACON_PROXY_URL` 或 `DESKBEACON_PROXY_AUTO=1` 来让 OAuth 配对过程使用代理；已有配置字段优先于环境回退。正式配对后通过上述 config 命令保存配置。

## 自动发现

- 所有平台：优先 `http_proxy`、`https_proxy`、`all_proxy`（及其大写形式），遵守 `NO_PROXY`；为方便 CLI 使用，只有 HTTP_PROXY 时 HTTPS 也可复用。
- Windows：使用 PowerShell 在当前运行用户身份下调用 .NET 的 `WebRequest.GetSystemWebProxy()`，针对 URL 查询 Windows Internet Options 的手动代理、PAC 与自动发现结果；适用于 Windows 自带的代理界面，不单纯读取注册表内保留的地址。以 SYSTEM 等服务账户运行时读取的设置可能不同。
- macOS：读取 `scutil --proxy` 的手动 HTTP/HTTPS/SOCKS 及自动配置 PAC URL。自动发现 WPAD 但没有可解析 PAC URL 的情形目前无法完整模拟原生 CFNetwork 行为。
- Linux：优先通用环境变量，之后尝试 GNOME `gsettings` 的手动代理和 PAC。没有统一 Linux 系统级代理 API，其他桌面环境建议使用环境变量。
- Termux/Android：环境变量优先，之后尝试 Android `getprop` 系统属性。透明 VPN/TUN 本来就无需应用层代理，不会被强行识别为 HTTP 代理。

系统代理发现结果缓存 15 秒，以免高频启动子进程；新请求能感知配置变化，已经建立的 WebSocket 会等下一次重连才更换路径。通过运行中的 CLI/TUI 修改配置时，Runtime 会主动重新建立 WebSocket；直接编辑 JSON 不会立即断开现有连接。

## 生效范围

- OAuth 注册、换取与刷新令牌
- 与 Worker 的 WebSocket 通道
- MCP `http_request` 工具

`net_probe` 的 DNS/TCP/TLS 与端口扫描是测量**目标设备实际直连网络**的诊断工具，刻意不进行应用层 HTTP 代理；用户仍可通过 MCP `http_request` 测试经代理的 HTTP 请求。来自 Agent 的 `exec_foreground` / `exec_background` 子进程独立于 DeskBeacon 网络库，它们是否走代理取决于自身设置或操作系统透明转发。

## 验证

```bash
pnpm check
pnpm --filter deskbeacon build
node --test apps/client/test/proxy-routing.mjs
node apps/client/test/config-cli.mjs
pnpm test
```

代理回归使用进程内的 HTTP 代理服务器和 WebSocket CONNECT 隧道，无需实际外部网络或修改用户系统代理。跨平台系统设置分支仍须在对应真实设备开启系统代理后各自验证。
