import type { Env } from "./env.js";

export const DEFAULT_AGENT_NAME = "Agent";

/**
 * OAuth client names are self-asserted metadata. Keep them useful in activity
 * views while removing terminal controls, line breaks, and bidirectional
 * overrides before the name is forwarded to a device.
 */
export function normalizeActorName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.normalize("NFC")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!normalized) return undefined;
	return [...normalized].slice(0, 80).join("");
}

/**
 * Prefer the name stored in a grant. Older grants predate actorName, so look up
 * the client using only the clientId authenticated by the OAuth provider.
 * Metadata failures must not make an otherwise valid MCP request fail.
 */
export async function resolveActorName(
	env: Pick<Env, "OAUTH_PROVIDER">,
	storedActorName: unknown,
	authenticatedClientId: unknown,
): Promise<string> {
	const storedName = normalizeActorName(storedActorName);
	// Earlier releases persisted the generic fallback into some grants. Treat
	// that value like a missing name so those grants can recover their label.
	if (storedName && storedName !== DEFAULT_AGENT_NAME) return storedName;
	if (typeof authenticatedClientId !== "string" || !authenticatedClientId.trim()) return DEFAULT_AGENT_NAME;

	try {
		const client = await env.OAUTH_PROVIDER.lookupClient(authenticatedClientId);
		if (client?.clientId !== authenticatedClientId) return DEFAULT_AGENT_NAME;
		return normalizeActorName(client.clientName) ?? DEFAULT_AGENT_NAME;
	} catch {
		// CIMD documents can become unavailable after a grant has been issued.
		// Preserve access and use a generic display name instead of failing MCP.
		return DEFAULT_AGENT_NAME;
	}
}
