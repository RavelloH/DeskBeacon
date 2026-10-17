/**
 * Authorization-server policy: generic MCP clients may request every
 * advertised scope. A combined request is deliberately downgraded to Agent
 * access, never a Device identity. Standalone Device authorization remains
 * available to the local pairing CLI.
 */
export const AGENT_SCOPE = "deskbeacon:agent" as const;
export const DEVICE_SCOPE = "deskbeacon:device" as const;
export type GrantedScope = typeof AGENT_SCOPE | typeof DEVICE_SCOPE;

export function scopeToGrant(requested: readonly string[]): GrantedScope | null {
  if (requested.length === 0 || requested.some(scope => scope !== AGENT_SCOPE && scope !== DEVICE_SCOPE)) return null;
  return requested.includes(AGENT_SCOPE) ? AGENT_SCOPE : DEVICE_SCOPE;
}
