import { describe, expect, it, vi } from "vitest";
import { resolveActorName } from "../src/oauth-actor.js";

function envWithLookup(lookupClient: (clientId: string) => Promise<unknown>) {
	return { OAUTH_PROVIDER: { lookupClient: vi.fn(lookupClient) } } as any;
}

describe("OAuth Agent display name", () => {
	it("uses the name saved on a newly issued grant without another metadata lookup", async () => {
		const env = envWithLookup(async () => { throw new Error("should not be called"); });

		await expect(resolveActorName(env, "Claude", "authenticated-client-id")).resolves.toBe("Claude");
		expect(env.OAUTH_PROVIDER.lookupClient).not.toHaveBeenCalled();
	});

	it("recovers a legacy grant name from the authenticated OAuth client registration", async () => {
		const lookupClient = vi.fn(async (clientId: string) => ({
			clientId,
			clientName: "ChatGPT",
			get clientSecret() { throw new Error("client secrets must not be read"); },
		}));
		const env = envWithLookup(lookupClient);

		await expect(resolveActorName(env, undefined, "registered-client-id")).resolves.toBe("ChatGPT");
		expect(lookupClient).toHaveBeenCalledOnce();
		expect(lookupClient).toHaveBeenCalledWith("registered-client-id");
	});

	it("replaces the old generic grant fallback with the registered client name", async () => {
		const env = envWithLookup(async (clientId: string) => ({ clientId, clientName: "ChatGPT" }));

		await expect(resolveActorName(env, "Agent", "registered-client-id")).resolves.toBe("ChatGPT");
	});

	it("falls back safely when the authenticated client has no usable metadata", async () => {
		const env = envWithLookup(async () => null);

		await expect(resolveActorName(env, undefined, "registered-client-id")).resolves.toBe("Agent");
		await expect(resolveActorName(env, " \r\n ", undefined)).resolves.toBe("Agent");
		expect(env.OAUTH_PROVIDER.lookupClient).toHaveBeenCalledOnce();
	});

	it("sanitizes malicious display metadata and rejects a mismatched client record", async () => {
		const env = envWithLookup(async () => ({
			clientId: "different-client-id",
			clientName: "\u001b[31mChatGPT\u001b[0m\r\nspoofed\u202e",
		}));

		await expect(resolveActorName(env, undefined, "authenticated-client-id")).resolves.toBe("Agent");
		const matchingEnv = envWithLookup(async (clientId: string) => ({
			clientId,
			clientName: "\u001b[31mChatGPT\u001b[0m\r\nspoofed\u202e",
		}));
		const result = await resolveActorName(matchingEnv, undefined, "authenticated-client-id");
		expect(result).toBe("ChatGPT spoofed");
		expect(result).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
	});

	it("keeps a valid request working when OAuth metadata lookup is unavailable", async () => {
		const env = envWithLookup(async () => { throw new Error("metadata unavailable"); });

		await expect(resolveActorName(env, undefined, "authenticated-client-id")).resolves.toBe("Agent");
	});
});
