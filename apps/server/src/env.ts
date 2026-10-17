export interface Env {
  OAUTH_KV: KVNamespace;
  DEVICE_SESSIONS: DurableObjectNamespace;
  PUBLIC_BASE_URL: string;
  OWNER_LOGIN: string;
  OWNER_PASSWORD_HASH?: string;
  OWNER_SESSION_SECRET?: string;
}

export type GrantProps =
  | { kind: 'agent'; ownerId: string; grantId: string }
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
