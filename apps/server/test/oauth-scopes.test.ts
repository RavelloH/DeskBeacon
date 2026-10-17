import { describe, expect, it } from "vitest";
import { AGENT_SCOPE, DEVICE_SCOPE, scopeToGrant } from "../src/oauth-scopes.js";

describe("OAuth Scope authorization policy", () => {
  it("approves Agent-only access for combined Agent + Device requests", () => {
    expect(scopeToGrant([AGENT_SCOPE, DEVICE_SCOPE])).toBe(AGENT_SCOPE);
    expect(scopeToGrant([DEVICE_SCOPE, AGENT_SCOPE])).toBe(AGENT_SCOPE);
  });
  it("allows independent, single-scope Agent and Device pairing", () => {
    expect(scopeToGrant([AGENT_SCOPE])).toBe(AGENT_SCOPE);
    expect(scopeToGrant([DEVICE_SCOPE])).toBe(DEVICE_SCOPE);
  });
  it("rejects missing and unrecognized scopes, even mixed with a known one", () => {
    expect(scopeToGrant([])).toBeNull();
    expect(scopeToGrant(["unknown"])).toBeNull();
    expect(scopeToGrant([AGENT_SCOPE, "admin"])).toBeNull();
  });
});
