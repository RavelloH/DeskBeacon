# OAuth 设备配对：CSP 拦截 loopback 回调（发布阻断）

## 影响范围

DeskBeacon 的 CLI `runSetupFlow` 在设备本机监听 `127.0.0.1:0`，获得随机端口并注册 OAuth redirect URI `http://127.0.0.1:<port>/callback`。浏览器打开 Worker 的 HTTPS `/authorize` 页面，向同源 `/authorize` 提交密钥后，Worker 返回 HTTP 302，指向该本地回调 URL。此前授权页发出的 CSP `form-action 'self' https:` 不允许该 HTTP 地址，因此 Chrome 等浏览器在表单后重定向中阻止了请求，CLI 因收不到 code 而等待超时。

此问题影响需要交互式浏览器配对的新设备和重新配对场景，**不意味着所有已经配对且可刷新令牌的设备会立即掉线**。

## 修复

服务端授权页面（`apps/server/src/auth-page.ts`）：

```http
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'
```

保留原有安全策略，**只额外允许 `http://127.0.0.1` 的随机端口**。没有引入 `http:`、`http://*` 或取消 `form-action`，也没有改变服务端的 OAuth client registration、PKCE、scope 降级、单次 consent handle、redirect URI 校验或 302 跳转。将纯页面响应生成逻辑提取到 `auth-page.ts` 方便常规 Vitest 验证（`auth.ts` 包含 Cloudflare 特殊模块，不能直接由 Node Vitest 导入）。

## 验证记录

- 2026-10-22：读取线上 `https://beacon.ravelloh.com/authorize` HTTP 400 响应，确认旧策略仍为 `form-action 'self' https:`（未部署修复）。
- ASUS Chrome + Playwright A/B 测试（脚本位于 gitignored `.agent/oauth-csp-chrome-smoke.cjs`）：两个临时本机端口模拟授权页面与回调端口，旧策略时 Chrome 控制台报告 CSP violation、回调请求 0 次；增加 `http://127.0.0.1:*` 后成功到达 `/callback?code=test`，回调请求 1 次。
- `apps/server/test/oauth-loopback-csp.test.ts`：验证授权页实际响应头保持 HTTPS、同源及严格 loopback 放行，不能任意 HTTP；服务端仍使用 302；客户端监听随机端口并使用同一 redirect URI。
- `apps/server/test/local-oauth-e2e.mjs`：增加对真实授权页响应头的断言（需独立运行 Wrangler dev E2E）。
- `pnpm check`、`pnpm build`（Worker dry-run）、`pnpm test`：通过，服务端 30 项测试均成功。
- 尚未做生产授权会话测试；在修复部署前，线上行为没有变化。

## 发布策略

**P0 阻断问题，建议单独做最小热修复**。不要将当前工作区中尚未验收的 v0.3.0 客户端/Batch/native/TUI 开发改动与此修复混合部署。若需要立即上线，应从当前生产版本建立独立 hotfix worktree，只移植页面 CSP 最小修复与测试，通过生产构建验证后另行部署。

不需要重装客户端、改变现有 OAuth 令牌或修改客户端注册方案。
