import { createMcpHandler } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { toolInputSchemas, TOOL_NAMES, type ToolName } from "@deskbeacon/protocol";
import type { Env, GrantProps, DeviceRecord } from "./env.js";
import { executeToolBatch } from "./batch.js";
import type { BatchInput } from "@deskbeacon/protocol";
import { resolveActorName } from "./oauth-actor.js";

type ApiCtx = ExecutionContext & { props?: GrantProps; auth?: { scope?: string[]; clientId?: string } };
const scopeAgent = "deskbeacon:agent", scopeDevice = "deskbeacon:device";

async function registry(env: Env): Promise<DeviceRecord[]> {
  const devices: DeviceRecord[] = [];
  let cursor: string | undefined;
  do {
    const keys = await env.OAUTH_KV.list({ prefix: "device:", limit: 250, ...(cursor ? { cursor } : {}) });
    for (const key of keys.keys) {
      const record = await env.OAUTH_KV.get(key.name, "json") as DeviceRecord | null;
      if (record && record.deviceId) devices.push(record);
    }
    cursor = keys.list_complete ? undefined : keys.cursor;
  } while (cursor && devices.length < 2000);
  return devices;
}

function secureError(code: string, message: string, operationId?: string): Record<string, unknown> {
  return { isError: true, code, message, ...(operationId ? { operationId } : {}) };
}

export async function dispatchTool(env: Env, name: ToolName, input: unknown, grantId: string, actorName?: string): Promise<Record<string,unknown>> {
  const schema = toolInputSchemas[name];
  const validated = schema.safeParse(input);
  if (!validated.success) return secureError("INVALID_INPUT", validated.error.message.slice(0, 1500));
  const data = validated.data as Record<string, unknown>;
  if (name === "batch") {
    return executeToolBatch(data as unknown as BatchInput,
      (tool,subInput) => dispatchTool(env,tool,subInput,grantId,actorName));
  }
  if (name === "device_list") {
    const records = await registry(env);
    // Check live DO WebSocket state only on Agent demand, never by polling.
    // Limit concurrent DO calls to keep list operations bounded.
    const updated: DeviceRecord[] = [];
    for (let offset = 0; offset < records.length; offset += 8) {
      const batch = records.slice(offset, offset + 8);
      updated.push(...await Promise.all(batch.map(async record => {
        try {
          const stub = env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(record.deviceId));
          const response = await stub.fetch("https://device.internal/status");
          if (!response.ok) return { ...record, state: "unknown" as const };
          const state = await response.json() as { online?: boolean };
          return { ...record, state: state.online ? "online" as const : "offline" as const };
        } catch {
          return { ...record, state: "unknown" as const };
        }
      })));
    }
    return { devices: updated, onlineStatus: "checked on request", offlineHint: "Offline only means no active device WebSocket. Start deskbeacon or deskbeacon service start on that computer; if unreachable, check power and network." };
  }
  const deviceId = data.deviceId as string;
  const stub = env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(deviceId));
  const result = await stub.fetch("https://device.internal/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input: data, grantId, actorName, operationId: crypto.randomUUID() }),
  });
  const body = await result.json() as Record<string, unknown>;
  if (body.isError === true && body.code === "DEVICE_OFFLINE") {
    return { ...body, nextStep: "The target device has no active WebSocket. On that computer, launch deskbeacon (foreground) or deskbeacon service start (background). Confirm network and power; then retry device_list before retrying the operation." };
  }
  return body;
}

export function makeMcpServer(env: Env, grantId: string, actorName?: string): McpServer {
  const server = new McpServer({ name: "deskbeacon", version: "0.1.0" });
  for (const name of TOOL_NAMES) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, {
      description: descriptions[name] ?? name.replaceAll("_", " "),
      inputSchema: schema as any,
    }, async (input: any) => {
      const result = await dispatchTool(env, name, input, grantId, actorName);
      const error = result.isError === true;
      const content: any[] = [];
      if (!error && name === "screen_capture" && typeof result.data === "object" && result.data &&
          "base64" in result.data && "mimeType" in result.data) {
        const data = result.data as { base64: string; mimeType: string };
        content.push({ type: "image", data: data.base64, mimeType: data.mimeType });
        const { base64: _, ...meta } = data;
        content.push({ type: "text", text: JSON.stringify(meta) });
      } else {
        content.push({ type: "text", text: JSON.stringify(result) });
      }
      return { content, structuredContent: result, isError: error };
    });
  }
  return server;
}

const descriptions: Record<string,string> = {
  device_list: "Find paired devices and their current live online/offline state. Call first when deviceId is unknown; records may remain listed while computers are powered off. Do not interpret lastSeenAt as continuous availability.",
  device_info: "Get a live device capability snapshot, current OS, supported shells, and default working directory. Requires an online device.",
  workspace_open: "Create an Agent-scoped working directory context for subsequent file and command tools. Returns workspaceId; shell cd commands do NOT update this context.",
  workspace_info: "Read Agent-scoped workspace cwd, shell profile and version. Requires workspaceId returned from workspace_open.",
  workspace_cd: "Change Agent-scoped workspace cwd with optional expectedVersion compare-and-swap. This affects subsequent workspace-aware operations, not the computer's global cwd.",
  fs_list: "List a bounded directory tree with depth/limit/cursor, sorting and hidden-file options. Prefer it over shell ls for ordinary filesystem discovery.",
  fs_stat: "Stat up to 100 explicit paths and optionally calculate file hashes. Use before edit when checking for concurrent changes.",
  fs_read: "Read a bounded file range; prefer lineOffset/maxLines for source code and byteOffset/maxBytes for binary. Returned ranges can be paged; never assume a preview is the complete file.",
  fs_read_many: "Read up to 8 source files in one MCP request, with per-file line/byte bounds, per-file errors and continuations, optional SHA-256 and a strict aggregate response budget. Prefer this for multi-file code context instead of many separate fs_read calls.",
  fs_write: "Create, rewrite or append file content with optional expectedHash and overwrite protection. Prefer expectedHash for sensitive concurrent edits.",
  fs_edit: "Edit one file atomically. mode=replace: oldText/newText, expectedReplacements defaults to 1; mode=replace_many: replacements array (1-64), validated together before writing; mode=patch: unified diff patch. LF/CRLF-compatible matching preserves the file\u0027s newline style. Use expectedHash to reject stale edits and dryRun to validate without writing. Mismatch errors include counts and candidate line numbers; edits never use fuzzy matching.",
  fs_manage: "Create directories, copy, move, rename or remove files; destructive actions are explicit. Do not use for archive extraction.",
  fs_archive: "Create, list or extract ZIP/TAR archives on the selected device. Specify paths and operation explicitly; archive data remains on that device.",
  exec_foreground: "Run a finite command and WAIT for its final exit, stdout, stderr and exit code in the SAME MCP call. Description is mandatory; use program+args to avoid shell escaping. Timeout is separate from front-end wait. No automatic background.",
  batch: "Compose multiple DeskBeacon tools on ONE device in serial stages or parallel read-only stages. Supports fs_read, fs_edit, exec_foreground, net_probe, etc. Use unique call ids; each input matches the standalone tool schema WITHOUT deviceId. Parallel stages permit read-only tools only. Per-call success, errors, and bounded result previews are returned; failFast stops subsequent stages. Outputs are not automatically passed as inputs to later calls. Use serial exec_foreground calls for command execution.",
  exec_background: "EXPLICITLY start a long-running process, get backgroundTaskId, then poll its output using cursor and stop when done. Never use for ordinary short commands.",
  background_list: "List local background process records and statuses, including exited tasks.",
  background_get: "Inspect a specific background task by backgroundTaskId.",
  background_output: "Retrieve incremental persisted stdout/stderr by cursor without replaying earlier data. Suitable for development server logs.",
  background_input: "Write input to a running background task, close stdin or send Ctrl+C. Does not spawn a new process.",
  background_stop: "Stop one specific background task/process tree. Safe to retry; requires backgroundTaskId.",
  operation_get: "Read metadata and result of a prior foreground operation from bounded durable history; requires operationId.",
  operation_output: "Page text stdout/stderr from a prior foreground operation by offset. Use when outputPreview is truncated or more detail is needed.",
  transfer_upload: "Transfer actual bytes supplied by the MCP host from Agent to device. Small inline transfers only unless the Host supports streaming; this tool does NOT fetch arbitrary URLs.",
  transfer_download: "Return actual device file bytes to requesting Agent; inline transfers are bounded. A URL string alone is not a downloaded file.",
  transfer_status: "Get status of a specific transferId. Inline transfers may have completed immediately.",
  transfer_cancel: "Cancel a currently active transfer when supported. Returns a clear reason if no active stream exists.",
  net_ports: "Inspect local listening ports or connections and owning PIDs on the selected device.",
  net_probe: "Test DNS, TCP or TLS connectivity FROM the selected device. Use to debug development endpoints or network reachability.",
  http_request: "Issue bounded HTTP requests FROM the device, including localhost-only APIs. Observe status/headers/body limits. Never send secrets in URL query strings.",
  system_snapshot: "Read CPU, memory, filesystem, and network system information without mutating the device.",
  system_processes: "List matching system processes by name or PID; read-only, not a process kill tool.",
  screen_capture: "Capture the current screen and return image content when desktop permissions permit. Use sparingly and avoid sensitive screens.",
  fs_find: "High performance filename and glob search via device-integrated ripgrep. Prefer this over shell-based recursive filesystem scans.",
  fs_grep: "Fast content grep via ripgrep with bounded structured results and truncation metadata.",
};

export async function handleApiRequest(request: Request, env: Env, ctx: ApiCtx): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const props = ctx.props;
  const scopes = ctx.auth?.scope ?? [];
  if (pathname === "/mcp") {
    if (props?.kind !== "agent" || !scopes.includes(scopeAgent)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    const grantId = props.grantId;
    const actorName = await resolveActorName(env, props.actorName, ctx.auth?.clientId);
    const handler = createMcpHandler(() => makeMcpServer(env, grantId, actorName), { legacy: "stateless" });
    return handler.fetch(request);
  }
  if (pathname === "/device/connect") {
    if (props?.kind !== "device" || !scopes.includes(scopeDevice)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "WebSocket required" }, { status: 426 });
    const record: DeviceRecord = {
      deviceId: props.deviceId, label: props.deviceName, lastSeenAt: new Date().toISOString(),
      state: "unknown",
    };
    await env.OAUTH_KV.put("device:" + props.deviceId, JSON.stringify(record));
    const stub = env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(props.deviceId));
    return stub.fetch(new Request("https://device.internal/connect", { headers: { upgrade: "websocket" } }));
  }
  if (pathname === "/device/info") {
    if (props?.kind !== "device" || !scopes.includes(scopeDevice)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    return Response.json({ deviceId: props.deviceId, protocolVersion: 1, label: props.deviceName });
  }
  return new Response("Not found", { status: 404 });
}
