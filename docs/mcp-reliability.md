# MCP 可靠性及兼容行为（2026-10-21）

本说明适用于源码中的新增行为。**只有升级并部署对应 Worker 与 Device 客户端（以及重新编译 Windows native 包）后，远程 MCP 才会提供这些能力。**

## 错误响应

工具失败应返回实际 `code`，而不是统一的 `TOOL_EXCEPTION`。例如 `ENOENT`、`EEXIST`、`REPLACEMENT_COUNT_MISMATCH`、`FILE_VERSION_CONFLICT`。未知异常仍可能是 `TOOL_EXCEPTION`。错误字段结构：`{isError:true,code,message,operationId?,partialResult?}`。文件版本冲突时 `partialResult.currentSha256` 返回读取到的当前文件哈希。对不存在的匹配，替换计数不符错误中的 `candidateLines` 可为 `none`；仅按第一条非空待匹配行寻找最多五个候选位置，不进行模糊修改。

## 前台执行

`exec_foreground.command.stdin` 为可选 UTF-8 输入（最多 1 MiB）；未指定时直接发送 EOF，因此不会由于 stdin 未关闭而挂起。指定时发送输入后关闭管道。Windows 需要配套的 Job Object helper 才能将 EOF 正确传给被运行程序；helper 中的 CreateProcessW 失败将被反映在 `spawnError` 中（进程退出码 125 不再是唯一诊断）。

超时首选 `exec_foreground.timeoutMs`（顶层），优先级高于兼容保留的 `command.timeoutMs`；均未提供时默认为 120 秒。`exec_background.command.timeoutMs` 不应视为前台超时控制。输出预览保留开头和末尾，并附带 `stdoutBytes`、`stderrBytes`、`totalOutputBytes`、`previewTruncated`。截断后使用 `operation_output` 分页读取原始历史。头尾预览中的跨流顺序按 stdout/stderr 分组，并非真实时间交织。

## Batch 子输出恢复

`batch` 接受 `transfer_upload`、`transfer_download` 和 `batch_output`（仍受每项工具的权限、大小及设备限制）。客户端执行的子调用返回 `childOperationId`。Batch 默认 `maxResultBytes=4096`，缩略结果并不代表历史数据丢失。

新工具 `batch_output` 输入：

```json
{
  "deviceId": "<device-id>",
  "parentOperationId": "<batch-operation-id>",
  "callId": "build",
  "stream": "stdout",
  "byteOffset": 0,
  "maxBytes": 65536
}
```

`stream` 支持 `stdout`、`stderr`、`result`；返回 `text`、`totalBytes`、`nextOffset`、`hasMore`。该历史保存在设备本地，只有相同授权的调用方能读；需要设备在线、原始记录仍存在。**目前用于文本及结果记录；批处理传输的 Base64 数据不会作为可恢复的二进制存放在本地记录中。需要二进制请单独使用 transfer_download。**

## 文件、归档与传输

- `fs_write.createParents`（默认 false）允许在 create/append 模式前创建父目录。rewrite 路径此前使用的原子写入函数本身就会创建父目录，继续兼容原有行为。
- `fs_edit.dryRun` 可返回 `diff`（最多约 64 Ki 字符）与 `diffTruncated`；不写磁盘。
- `fs_list` 同时返回 `kind` 与 `type`、`modifiedAt` 与 `modified`；`fs_stat` 同样保留两组兼容别名。
- `fs_find.includeDirectories`（默认 false）通过有界目录遍历额外返回目录，**包括真正的空目录**；`entries.kind` 区分文件与目录，关闭时仍沿用 ripgrep 的文件搜索。目录遍历不追踪符号链接，受 5 万目录/30 秒上限及 `maxResults` 限制，达到上限会报告 `truncated`。目录忽略规则尽力通过 Git `check-ignore` 执行 `.gitignore`（需要安装 Git，且目标位于 Git 工作区）；目录匹配支持常见 glob，但复杂 glob 与 `.ignore`/`.rgignore` 的语义可能与 ripgrep 不完全一致。
- ZIP 和 TAR 列表都返回 `name,size,type,directory,compressedSize`（TAR 的 compressedSize 为 null，并附 archiveType）；新建 TAR 与 ZIP 都提供 SHA-256。
- `transfer_download.offset`（默认 0）及 `maxBytes`（单次不大于 128 KiB）用于文件分页，响应包括 `totalBytes,offset,nextOffset,hasMore`。响应中的 `sha256` **仅验证本页**，并非整个文件摘要。分块期间若源文件被修改，则不能保证一致性；需要时先检查源文件版本。
- `workspace_open.workspaceId` 若显式提供，则创建该 ID 或重开同授权现有工作区；重开时保留当前 cwd/version，不覆盖现有目录。
- `background_get.task` 附带 camelCase 字段别名以兼容原始 snake_case。
- `net_ports.localPort` 现在是数字；Windows 使用 netstat 跳过中文系统上被误识别成记录的表头。尽力查询 PID 的进程名与用户名，受操作系统权限限制。

## 验证

执行 `pnpm check`、`pnpm build`、`pnpm test`、`node apps/client/test/fs-edit.mjs`、`node apps/client/test/mcp-batch-output.mjs`。Windows 原生 stdin 测试需先编译新版本 helper，然后：

```powershell
$env:DESKBEACON_JOB_BINARY = 'E:/DeskBeacon/.agent/deskbeacon-job-fixed.exe'
node apps/client/test/mcp-reliability.mjs
```

仓库的默认编译器是 LLVM-mingw，当前开发机器只有 TDM-GCC，故使用临时本地构建验证，**尚未把新 helper 重建进正式发布包**。未执行生产部署、发布、重启或 Git 提交。
