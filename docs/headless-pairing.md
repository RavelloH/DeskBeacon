# 无浏览器设备授权（0.3.0 开发版）

DeskBeacon 提供基于现有 OAuth Authorization Code + PKCE 的跨设备配对中继。**这不是 RFC 8628 Device Authorization Grant**：配对服务只暂存经 OAuth Provider 签发的授权码，仍由设备向标准 `/oauth/token` 完成 Token 交换。没有新增 Access Token / Refresh Token 生成与刷新系统。

## 使用方式

```bash
deskbeacon setup --device --url https://beacon.example.com
deskbeacon setup --browser --url https://beacon.example.com
```

默认 `setup` 在 Linux 无图形环境、Android 或没有 TTY 输出时自动使用 `--device`；桌面 TTY 使用 `--browser`。TUI 会显示验证码，非 TTY 则打印纯文本指令。

设备收到 `verification_uri`、`user_code`（例：`ABCD-2345`）、`device_code`（仅客户端持有）、过期秒数和轮询间隔。手机访问 `/activate`、输入验证码、在现有 `/authorize` 页确认所请求的 `deskbeacon:device` 权限并输入 `MCP_AUTH_SECRET`。Worker 接收标准 OAuth 回调，客户端轮询领取授权码，凭自己本地的 PKCE Verifier 换取并保存 Token。手机不会收到设备 Token。

## 接口与流程

1. 客户端在本地生成 32 字节 PKCE Verifier/Challenge；向 `/oauth/register` 注册公开客户端，回调固定 `https://服务器域名/pair/callback`，Scope 固定 `deskbeacon:device`。
2. `POST /pair/start`：提交 `client_id`、`code_challenge`、`device_name`。服务端通过 OAuth Provider 的 `lookupClient()` 验证 Client 存在、类型与注册回调一致。生成随机的 256 位 device_code、256 位 OAuth state、8 位可输入 user_code。
3. `POST /pair/poll`：使用高熵 device_code 查询，未确认时返回 `202 {status:"pending",interval:5}`。
4. `GET /activate`、`POST /activate`：浏览器提交短码后，Worker 用 session 中的 Client ID、Challenge、State 构建 `/authorize` 跳转。浏览器依然使用 OAuth Provider 的授权页面、同意句柄和管理密钥。
5. `GET /pair/callback`：验证 session/state，存储来自原 OAuth Provider 的一次性授权码或拒绝状态；只展示完成页。
6. 客户端轮询获知 `authorized` 后，调用 `/oauth/token` 携带授权码、Client ID、已注册回调和 PKCE Verifier。只有此时才覆盖原设备配置。

## 数据存储与安全边界

- 使用已有 Cloudflare `OAUTH_KV`，按 session、用户短码和 OAuth state 建立三种 300 秒 TTL 键。
- `device_code` 仅返回给 CLI，KV 用其 SHA-256 摘要查找 session，不存储明文原始 device_code。
- user_code 不能兑换 Token，仅关联 OAuth 授权请求；页面仍强制验证原有管理密钥。
- 注册的回调地址必须精确匹配 Worker 的 `/pair/callback`。短码不进入 OAuth Token 端点。
- POST activation 校验同源 Origin、表单类型与正文长度。创建会话及浏览器短码尝试使用按客户端 IP 的基础 KV 限流；轮询凭 256 位随机 device_code 只执行 KV 读取，避免轮询期间持续写入 KV。
- 所有敏感响应采用 `no-store`。授权码是上游不透明字符串，不对其字符集合做不合理的限制。
- Worker KV 非事务、跨地区最终一致；可能有短暂传播延迟，不能把 KV 的“状态已读取”当作强一致一次性领取保证。实际安全边界是 OAuth Provider 的单次使用授权码与 PKCE；如果要在此层实现严格原子领取，可切换为 Durable Object。
- 完成配对后仍复用 OAuth 原有刷新、Audience 和 deviceId = clientId 身份模型。

## 验证

```bash
pnpm check
pnpm build
pnpm test
pnpm test:local
```

新增单元/端到端测试覆盖配对状态机、非法客户端、错误验证码、过期、拒绝、PKCE、Token 保存、取消后旧配置保留。另在本地 Wrangler 真实 OAuth Provider 上验证过完整的浏览器同意、OAuth 回调、Token 交换，并实际由无 TTY 的 `deskbeacon setup --device` 完成授权。

生产上线需要部署更新后的 Worker 后，目标设备才能调用新端点；此次开发阶段未发布或部署生产。
