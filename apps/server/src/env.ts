export interface Env {
  OAUTH_KV: KVNamespace;
  DEVICE_SESSIONS: DurableObjectNamespace;

  MCP_BASE_URL?: string;
  MCP_AUTH_SECRET: string;
}

export type GrantProps =
  | { kind: 'agent'; ownerId: string; grantId: string; actorName?: string }
  | { kind: 'device'; ownerId: string; deviceId: string; deviceName: string };

export interface DeviceRecord {
  deviceId: string;
  label: string;
  lastSeenAt: string | null;
  state: 'online' | 'offline' | 'unknown';
  protocolVersion?: number;
  platform?: string;
  clientVersion?: string;
}

export function deviceStub(env: Env, deviceId: string): DurableObjectStub {
  return env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(deviceId));
}
