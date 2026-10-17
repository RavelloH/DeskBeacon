import OAuthProvider, { type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./auth.js";
import { handleApiRequest } from "./api.js";
import { DeviceSession } from "./device-session.js";
import type { Env } from "./env.js";

export { DeviceSession };

// The upstream per-request OAuthProvider; DeskBeacon has two OAuth-protected API paths.
export function oauthOptionsFor(env: Env, request: Request): OAuthProviderOptions<Env> {
  const configuredBase = (env.MCP_BASE_URL ?? "").trim();
  const origin = configuredBase ? new URL(configuredBase).origin : new URL(request.url).origin;
  return {
    apiRoute: ["/mcp", "/device/"],
    apiHandler: { fetch: (req, requestEnv, ctx) => handleApiRequest(req, requestEnv, ctx as any) },
    defaultHandler: {
      fetch(req, requestEnv) {
        const url = new URL(req.url);
        if (url.pathname === "/authorize") return handleAuthorize(req, requestEnv);
        if (url.pathname === "/health" && req.method === "GET") return Response.json({ status: "ok", service: "deskbeacon-server" });
        return new Response("Not found", { status: 404 });
      }
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["deskbeacon:agent", "deskbeacon:device"],
    requiredScopes: [],
    resourceMetadata: { resource: origin, authorization_servers: [origin], resource_name: "DeskBeacon" },
    clientIdMetadataDocumentEnabled: true,
    refreshTokenTTL: 90 * 24 * 60 * 60,
    refreshTokenIdleTTL: 30 * 24 * 60 * 60
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return new OAuthProvider<Env>(oauthOptionsFor(env, request)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
