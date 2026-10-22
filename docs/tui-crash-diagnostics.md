# TUI 致命错误诊断（待 v0.3.0）

## 日志
日志位于 `~/.deskbeacon/logs/tui.jsonl`，可通过 `deskbeacon service logs tui` 查看。致命异常和终止信号只在发生时同步记录，不额外设置定时任务。

## 诊断行为
- `session.started`：TUI 启动时记录一次。
- `session.exited` / `session.failed`：正常退出或可捕获的渲染异常。
- `session.uncaught`：未捕获异常，尽量同步保存完整脱敏堆栈。
- `session.signal_exit`：收到 SIGINT、SIGTERM 或 SIGBREAK 时记录信号及退出码。

**不添加会话心跳、周期 RSS 采样、会话标记或后台轮询。**

如果进程被任务管理器强制终止、发生 SIGKILL 或断电，Node 无法执行清理/日志回调，因而不能保证有退出记录。

## 2026-10-21 事故
旧日志 PID 44492 于北京时间 15:43:12 启动，之后没有对应的退出记录。用户提供的实际堆栈进一步确定 TUI 在 Ink 7.1.1 的渲染路径 `@alcalzone/ansi-tokenize@0.3.1/build/diff.js` 抛出 TypeError：
`undoAnsiCodes is not a function or its return value is not iterable`。触发条件待深入调查，不应仅据此归因于应用数据异常。

## 验证
运行 `node apps/client/test/tui-terminal-guard.mjs` 和 `node apps/client/test/foreground-survivability.mjs`。两项测试均不依赖会话心跳。新版异常日志不会追溯补全已退出旧进程的信息。
