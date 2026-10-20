# DeskBeacon 可观测性与诊断日志

DeskBeacon 使用 `rlog-js` v3。诊断文件统一存放在 `~/.deskbeacon/logs/`（Windows：`%USERPROFILE%\.deskbeacon\logs\`）；若指定 `DESKBEACON_DATA_DIR`，则改为其下的 `logs/`。

| 领域文件 | 单文件上限 | 历史文件数 | 主要事件 |
|---|---:|---:|---|
| `service.jsonl` | 2 MiB | 3 | Supervisor 启停、Worker 启动/退出、重启、连续重启超限、stderr 诊断 |
| `runtime.jsonl` | 4 MiB | 3 | Runtime 生命周期、Node 警告、console.warn/error、未捕获异常、未处理的 Promise 拒绝 |
| `connection.jsonl` | 2 MiB | 3 | connecting/open/closed/error、握手/心跳超时、重连、首次 Pong、设备就绪 |
| `execution.jsonl` | 4 MiB | 3 | 工具异常结束、执行超时、输出截断、后台任务退出、停止请求、日志写入失败、结果恢复失败 |
| `migration.jsonl` | 2 MiB | 2 | 升级开始/完成/失败、每步进度、旧记录迁移错误 |
| `security.jsonl` | 2 MiB | 3 | OAuth 刷新失败及后续安全相关告警 |

每个领域独立按照字节数轮转，保留当前文件和指定数量的历史文件。日志按需、事件驱动写入；空闲期间不进行定时日志扫描。JSONL 事件含时间戳、级别、事件类型、进程 PID 和脱敏后的相关上下文。

`records/YYYY/MM/DD/*.jsonl` 仍为**每次工具调用独立的原始输入输出 Journal**，用于结果重放和用户详情；它不是运行时诊断日志，不复制到 rlog-js，避免双重存储 stdout/stderr。SQLite 不再写 `connection_events`，新 Runtime 首次打开数据库会删除旧表。旧 `service.log` 与 `service.log.1` 会被移除。

查看：
```sh
deskbeacon service logs
deskbeacon service logs connection
deskbeacon service logs execution
deskbeacon service logs runtime
deskbeacon service logs migration
deskbeacon service logs security
```
默认查看 service，展示当前日志末尾约 18 KiB。完整查询可自行使用文件查看器或 `rg` 检索 `logs/` 中的轮转文件。

崩溃时记录错误名称、消息、堆栈、内存和运行时长，并尝试 flush 再以错误退出。对于 `SIGKILL` 或强制终止，进程本身无法写入最后一条日志，但 Supervisor 会记录异常退出和重启。所有诊断字段按敏感键与常见凭据模式脱敏；避免记录完整命令脚本和文件内容。

发布版通过 `stage-npm.mjs` 排除 Demo 实际源码，`deskbeacon demo` 不可用；开发版仍保留模拟 UI。
