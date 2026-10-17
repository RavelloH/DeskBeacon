import { createMcpHandler } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { toolInputSchemas, TOOL_NAMES, type ToolName } from "@deskbeacon/protocol";
import type { Env, GrantProps, DeviceRecord } from "./env.js";

type ApiCtx = ExecutionContext & { props?: GrantProps; auth?: { scope?: string[] } };
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

export async function dispatchTool(env: Env, name: ToolName, input: unknown, grantId: string) {
  const schema = toolInputSchemas[name];
  const validated = schema.safeParse(input);
  if (!validated.success) return secureError("INVALID_INPUT", validated.error.message.slice(0, 1500));
  const data = validated.data as Record<string, unknown>;
  if (name === "device_list") {
    const records = await registry(env);
    return { devices: records, onlineStatus: "last-known (KV eventual consistency)" };
  }
  const deviceId = data.deviceId as string;
  const stub = env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(deviceId));
  const result = await stub.fetch("https://device.internal/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input: data, grantId, operationId: crypto.randomUUID() }),
  });
  const body = await result.json() as Record<string, unknown>;
  return body;
}

export function makeMcpServer(env: Env, grantId: string): McpServer {
  const server = new McpServer({ name: "deskbeacon", version: "0.1.0" });
  for (const name of TOOL_NAMES) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, {
      description: descriptions[name] ?? name.replaceAll("_", " "),
      inputSchema: schema as any,
    }, async (input: any) => {
      const result = await dispatchTool(env, name, input, grantId);
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
  exec_foreground: "Execute a single finite command synchronously on the selected device; waits until command exits, is cancelled, or times out. Never runs in background. A short human-readable description is mandatory.",
  exec_batch: "Execute staged commands synchronously; serial stages and parallel commands inside a stage. One foreground slot per device. All managed processes end before response.",
  exec_background: "Explicitly create a long-running process; returns a background task ID. Use background_* tools to manage it.",
  fs_find: "High performance filename and glob search via device-integrated ripgrep. Prefer this over shell-based recursive filesystem scans.",
  fs_grep: "Fast content grep via ripgrep with bounded structured results and truncation metadata.",
  operation_output: "Read recent bounded foreground stdout/stderr TEXT from the device Durable Object by offset or filters.",
  transfer_upload: "Send actual file bytes supplied by the MCP host to this device. Large host file transfer may not be supported.",
  transfer_download: "Read file bytes from a device for the requesting Agent. Never automatically copy between devices.",
};

export async function handleApiRequest(request: Request, env: Env, ctx: ApiCtx): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const props = ctx.props;
  const scopes = ctx.auth?.scope ?? [];
  if (pathname === "/mcp") {
    if (props?.kind !== "agent" || !scopes.includes(scopeAgent)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    const grantId = props.grantId;
    const handler = createMcpHandler(() => makeMcpServer(env, grantId), { legacy: "stateless" });
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
