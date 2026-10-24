# 统一 Wrangler 配置与 KV 环境变量覆盖

仓库唯一维护的 Wrangler JSONC 是根目录 `wrangler.jsonc`。它属于 fork 用户，可以自行写入资源 ID；**构建、部署和开发脚本绝不回写该文件**。

## Cloudflare 一键部署

在 Workers Builds 中使用：

| 配置 | 值 |
| --- | --- |
| Root directory | `/` |
| Build command | `pnpm build` |
| Deploy command | `pnpm deploy` |
| `NODE_VERSION` | `24` |
| `PNPM_VERSION` | `11.1.3` |

**已有实例**：在 Cloudflare Workers Builds 的**构建环境变量（Build variables）**设置 `DESKBEACON_OAUTH_KV_ID` 为原有 `OAUTH_KV` 的真实 32 位十六进制 Namespace ID，确保升级不会误绑定到空 KV。Build variables 与 Worker 运行时 Variables and Secrets 不同，必须在执行部署命令的进程里生效。

**全新 fork**：无需配置 KV ID。对于根配置原本的全零占位 ID，部署脚本会在**临时 JSON** 中移除 ID，让 Wrangler 自动创建或复用该 Worker 的 KV。要求 Wrangler 4.45.0 或以上。部署器不会修改源文件。

如果 fork 用户已经手动在根 `wrangler.jsonc` 中填写非零 ID，不设置环境变量时该 ID 会保持不变；设置了 `DESKBEACON_OAUTH_KV_ID` 时则以环境变量为准。

不要使用 Cloudflare Workers Builds 默认的 `npx wrangler deploy` 直接代替 `pnpm deploy`，否则会绕过配置转换逻辑。

## 本地部署

PowerShell：

```powershell
$env:DESKBEACON_OAUTH_KV_ID = '<existing-namespace-id>'
pnpm deploy
```

Bash：

```bash
export DESKBEACON_OAUTH_KV_ID='<existing-namespace-id>'
pnpm deploy
```

可选 `DESKBEACON_WORKER_NAME` 覆盖 Worker 名称。首次全新部署可省略环境变量，由 Wrangler 自动预配 KV。

## 实现方式

`pnpm deploy`、`pnpm run dev:server` 和服务器的 `build` 使用 `scripts/wrangler-run.mjs`：

1. 读取根目录用户维护的 `wrangler.jsonc`（支持注释及尾随逗号）。
2. 校验 `DESKBEACON_OAUTH_KV_ID`，如果它非空则覆盖临时配置中的 `OAUTH_KV.id`。
3. 全零占位时移除临时配置的 ID，允许自动预配；已填写的有效 ID 不变。
4. 在根目录生成被 Git 忽略的随机 `.wrangler.generated.*.json`，调用 Wrangler `--config` 使用它，执行结束后删除。
5. `deploy` 带 `--keep-vars`，保护 Dashboard 中已有的运行时变量；不读取或输出 OAuth Secret。

根 `wrangler.jsonc` 不会重写、格式化、提交或被构建脚本替换。仓库已删除 `apps/server/wrangler.jsonc`，避免两份配置分叉。

## 验证

```bash
node --test scripts/wrangler-config.test.mjs
pnpm build
```

这些测试覆盖 fork ID 保留、环境变量优先、占位 ID 自动预配、错误 ID 拒绝与根配置不变。生产部署前仍须核对原有 KV Namespace ID。
