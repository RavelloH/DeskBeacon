import { z } from 'zod';
import { LIMITS } from './constants.js';
import { batchInputSchema } from './batch.js';

const DeviceId = z.string().trim().min(1).max(128);
const WorkspaceId = z.string().trim().min(1).max(128);
const Description = z.string().trim().min(1).max(120);
const Path = z.string().min(1).max(8_192);
const Cursor = z.string().max(512).optional();
const Environment = z.record(z.string(), z.string().max(8_192)).optional();
const CommonDevice = { deviceId: DeviceId };
const CommandSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('program'),
    program: z.string().min(1).max(2_048),
    args: z.array(z.string().max(32_768)).max(256).default([]),
    cwd: Path.optional(),
    workspaceId: WorkspaceId.optional(),
    env: Environment,
    timeoutMs: z.number().int().min(1).max(LIMITS.maxForegroundTimeoutMs).optional(),
  }).strict(),
  z.object({
    mode: z.literal('shell'),
    script: z.string().min(1).max(256_000),
    shellProfile: z.string().min(1).max(128).optional(),
    cwd: Path.optional(),
    workspaceId: WorkspaceId.optional(),
    env: Environment,
    timeoutMs: z.number().int().min(1).max(LIMITS.maxForegroundTimeoutMs).optional(),
  }).strict(),
]);

const ForegroundCommand = CommandSchema.and(z.object({ idempotencyKey: z.string().min(1).max(128).optional() }));
const CursorPage = {
  cursor: Cursor,
  limit: z.number().int().min(1).max(500).optional(),
};

export const toolInputSchemas = {
  device_list: z.object({ includeRevoked: z.boolean().default(false), ...CursorPage }).strict(),
  device_info: z.object({ ...CommonDevice }).strict(),
  workspace_open: z.object({ ...CommonDevice, path: Path, shellProfile: z.string().max(128).optional(), workspaceId: WorkspaceId.optional() }).strict(),
  workspace_info: z.object({ ...CommonDevice, workspaceId: WorkspaceId }).strict(),
  workspace_cd: z.object({ ...CommonDevice, workspaceId: WorkspaceId, path: Path, expectedVersion: z.number().int().nonnegative().optional() }).strict(),
  fs_list: z.object({ ...CommonDevice, path: Path, depth: z.number().int().min(0).max(32).default(1), limit: z.number().int().min(1).max(2_000).default(200), cursor: Cursor, sortBy: z.enum(['name', 'size', 'modified']).default('name'), includeHidden: z.boolean().default(false), followSymlinks: z.boolean().default(false), workspaceId: WorkspaceId.optional() }).strict(),
  fs_stat: z.object({ ...CommonDevice, paths: z.array(Path).min(1).max(100), hash: z.boolean().default(false), workspaceId: WorkspaceId.optional() }).strict(),
  fs_read: z.object({ ...CommonDevice, path: Path, encoding: z.enum(['utf8', 'utf16le', 'base64']).default('utf8'), byteOffset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(1_048_576).default(65_536), lineOffset: z.number().int().nonnegative().optional(), maxLines: z.number().int().min(1).max(10_000).optional(), workspaceId: WorkspaceId.optional() }).strict(),
  // Efficient context gathering: bounded per-file reads and a hard aggregate response budget.
  fs_read_many: z.object({
    ...CommonDevice, workspaceId: WorkspaceId.optional(),
    files: z.array(z.object({
      path: Path,
      encoding: z.enum(['utf8', 'utf16le']).default('utf8'),
      lineOffset: z.number().int().nonnegative().optional(),
      maxLines: z.number().int().min(1).max(2_000).optional(),
      byteOffset: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1).max(8_192).default(4_096),
    }).strict()).min(1).max(8),
    maxTotalBytes: z.number().int().min(1_024).max(65_536).default(32_768),
    includeHash: z.boolean().default(false),
  }).strict(),
  fs_find: z.object({ ...CommonDevice, path: Path, pattern: z.string().max(2_048).optional(), glob: z.array(z.string().max(512)).max(64).default([]), includeHidden: z.boolean().default(false), respectIgnore: z.boolean().default(true), maxResults: z.number().int().min(1).max(20_000).default(1_000), cursor: Cursor, workspaceId: WorkspaceId.optional() }).strict(),
  fs_grep: z.object({ ...CommonDevice, path: Path, pattern: z.string().min(1).max(16_384), literal: z.boolean().default(false), caseSensitive: z.boolean().default(false), glob: z.array(z.string().max(512)).max(64).default([]), contextLines: z.number().int().min(0).max(20).default(0), maxResults: z.number().int().min(1).max(10_000).default(500), maxBytes: z.number().int().min(1).max(8_388_608).default(1_048_576), timeoutMs: z.number().int().min(1).max(120_000).default(30_000), cursor: Cursor, workspaceId: WorkspaceId.optional() }).strict(),
  fs_write: z.object({ ...CommonDevice, path: Path, mode: z.enum(['create', 'rewrite', 'append']), content: z.string().max(1_048_576), encoding: z.enum(['utf8', 'base64']).default('utf8'), expectedHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(), overwrite: z.boolean().default(false), workspaceId: WorkspaceId.optional() }).strict(),
  fs_edit: z.discriminatedUnion('mode', [
    z.object({ ...CommonDevice, path: Path, mode: z.literal('replace'), oldText: z.string().min(1).max(256_000), newText: z.string().max(256_000), expectedReplacements: z.number().int().min(1).max(1_000).default(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(), workspaceId: WorkspaceId.optional() }).strict(),
    z.object({ ...CommonDevice, path: Path, mode: z.literal('patch'), patch: z.string().min(1).max(512_000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(), workspaceId: WorkspaceId.optional() }).strict(),
  ]),
  fs_manage: z.object({ ...CommonDevice, action: z.enum(['mkdir', 'copy', 'move', 'rename', 'remove']), path: Path, destination: Path.optional(), recursive: z.boolean().default(false), overwrite: z.boolean().default(false), workspaceId: WorkspaceId.optional() }).strict(),
  exec_foreground: z.object({ ...CommonDevice, description: Description, command: CommandSchema, timeoutMs: z.number().int().min(1).max(LIMITS.maxForegroundTimeoutMs).default(LIMITS.defaultForegroundTimeoutMs), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  batch: batchInputSchema,
  exec_background: z.object({ ...CommonDevice, description: Description, command: CommandSchema, terminal: z.enum(['pipe', 'pty']).default('pipe'), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  background_list: z.object({ ...CommonDevice, state: z.enum(['running', 'exited', 'detached', 'all']).default('all'), limit: z.number().int().min(1).max(500).default(100), cursor: Cursor }).strict(),
  background_get: z.object({ ...CommonDevice, backgroundTaskId: z.string().min(1).max(128) }).strict(),
  background_output: z.object({ ...CommonDevice, backgroundTaskId: z.string().min(1).max(128), stream: z.enum(['stdout', 'stderr', 'both']).default('both'), cursor: Cursor, maxLines: z.number().int().min(1).max(5_000).default(200), maxBytes: z.number().int().min(1).max(1_048_576).default(65_536) }).strict(),
  background_input: z.object({ ...CommonDevice, backgroundTaskId: z.string().min(1).max(128), data: z.string().max(65_536), signal: z.enum(['none', 'eof', 'ctrl_c']).default('none') }).strict(),
  background_stop: z.object({ ...CommonDevice, backgroundTaskId: z.string().min(1).max(128), graceMs: z.number().int().min(0).max(30_000).default(2_000) }).strict(),
  operation_get: z.object({ ...CommonDevice, operationId: z.string().min(1).max(128) }).strict(),
  operation_output: z.object({ ...CommonDevice, operationId: z.string().min(1).max(128), stream: z.enum(['stdout', 'stderr', 'both']).default('both'), byteOffset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(1_048_576).default(65_536), lineOffset: z.number().int().nonnegative().optional(), maxLines: z.number().int().min(1).max(10_000).optional(), literalContains: z.string().max(4_096).optional() }).strict(),
  transfer_upload: z.object({ ...CommonDevice, description: Description, targetPath: Path, dataBase64: z.string().max(LIMITS.transferInlineBase64Chars).optional(), expectedBytes: z.number().int().nonnegative().max(LIMITS.transferInlineBytes).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), overwrite: z.boolean().default(false), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  transfer_download: z.object({ ...CommonDevice, description: Description, sourcePath: Path, maxBytes: z.number().int().min(1).max(LIMITS.transferInlineBytes).default(LIMITS.transferInlineBytes) }).strict(),
  transfer_status: z.object({ ...CommonDevice, transferId: z.string().min(1).max(128) }).strict(),
  transfer_cancel: z.object({ ...CommonDevice, transferId: z.string().min(1).max(128) }).strict(),
  fs_archive: z.discriminatedUnion('action', [
    z.object({ ...CommonDevice, action: z.literal('create'), description: Description, sourcePaths: z.array(Path).min(1).max(256), outputPath: Path, format: z.enum(['zip', 'tar', 'tar.gz']), excludeGlobs: z.array(z.string().max(512)).max(128).default([]), maxBytes: z.number().int().min(1).max(4_294_967_296).default(1_073_741_824), overwrite: z.boolean().default(false) }).strict(),
    z.object({ ...CommonDevice, action: z.literal('extract'), description: Description, archivePath: Path, targetDirectory: Path, maxExpandedBytes: z.number().int().min(1).max(4_294_967_296).default(1_073_741_824), maxEntryCount: z.number().int().min(1).max(100_000).default(20_000), overwrite: z.boolean().default(false) }).strict(),
    z.object({ ...CommonDevice, action: z.literal('list'), archivePath: Path, limit: z.number().int().min(1).max(2_000).default(200), cursor: Cursor }).strict(),
  ]),
  net_ports: z.object({ ...CommonDevice, protocol: z.enum(['tcp', 'udp', 'all']).default('tcp'), state: z.enum(['listen', 'established', 'all']).default('listen'), address: z.string().max(256).optional(), port: z.number().int().min(1).max(65_535).optional(), pid: z.number().int().positive().optional(), limit: z.number().int().min(1).max(2_000).default(200), cursor: Cursor }).strict(),
  net_probe: z.discriminatedUnion('mode', [
    z.object({ ...CommonDevice, mode: z.literal('dns'), hostname: z.string().min(1).max(253), recordType: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT']).default('A'), timeoutMs: z.number().int().min(1).max(30_000).default(5_000) }).strict(),
    z.object({ ...CommonDevice, mode: z.literal('tcp'), host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535), timeoutMs: z.number().int().min(1).max(30_000).default(5_000) }).strict(),
    z.object({ ...CommonDevice, mode: z.literal('tls'), host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535).default(443), timeoutMs: z.number().int().min(1).max(30_000).default(5_000) }).strict(),
  ]),
  http_request: z.object({ ...CommonDevice, method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']), url: z.string().url().max(8_192), headers: z.record(z.string(), z.string().max(8_192)).default({}), body: z.string().max(1_048_576).optional(), timeoutMs: z.number().int().min(1).max(60_000).default(5_000), maxResponseBytes: z.number().int().min(1).max(2_097_152).default(65_536), redirect: z.enum(['manual', 'follow', 'error']).default('follow'), maxRedirects: z.number().int().min(0).max(10).default(3) }).strict(),
  system_snapshot: z.object({ ...CommonDevice, includeDisks: z.boolean().default(true), includeNetwork: z.boolean().default(true) }).strict(),
  system_processes: z.object({ ...CommonDevice, name: z.string().max(256).optional(), pid: z.number().int().positive().optional(), sortBy: z.enum(['cpu', 'memory', 'name', 'pid']).default('cpu'), limit: z.number().int().min(1).max(2_000).default(200), cursor: Cursor }).strict(),
  screen_capture: z.object({ ...CommonDevice, monitor: z.number().int().nonnegative().optional(), rect: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).strict().optional(), format: z.enum(['png', 'jpeg']).default('jpeg'), maxWidth: z.number().int().min(1).max(3_840).default(1_920), maxHeight: z.number().int().min(1).max(2_160).default(1_080), quality: z.number().min(0.1).max(1).default(0.8) }).strict(),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInput<Name extends ToolName> = z.infer<(typeof toolInputSchemas)[Name]>;
export const TOOL_NAMES = Object.keys(toolInputSchemas) as ToolName[];
