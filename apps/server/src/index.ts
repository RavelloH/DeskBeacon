import { OAuthAuthorizationServer, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./auth.js";
import { handleApiRequest } from "./api.js";
import { DeviceSession } from "./device-session.js";
import type { Env, GrantProps } from "./env.js";

export { DeviceSession };

/**
 * Keep the original origin audience registered for existing Device grants.
 * New MCP clients use /mcp as their canonical RFC 8707 resource instead.
 * Both roles share the same OAuth KV and authorization endpoints.
 */
export function oauthResourcesFor(env: Env, request: Request) {
  const configuredBase = (env.MCP_BASE_URL ?? "").trim();
  const origin = configuredBase ? new URL(configuredBase).origin : new URL(request.url).origin;
  const mcpResource = origin + "/mcp";

  const authorizationServer = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    // Advertise the MCP audience first: generic OAuth clients may select the
    // first protected resource, while old Device grants still use the origin.
    resources: [mcpResource, origin],
    defaultResource: origin, // Old Device clients omit resource during authorization.
    legacyGrantResource: origin, // Keep grants written before resource binding.
    scopesSupported: ["deskbeacon:agent", "deskbeacon:device"],
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    refreshTokenTTL: 90 * 24 * 60 * 60,
    refreshTokenIdleTTL: 30 * 24 * 60 * 60
  });

  const validateToken = (requestEnv: Env) => (resource: string, token: string) =>
    authorizationServer.validateToken(resource, token, requestEnv);
  const handler = {
    fetch: (req: Request, requestEnv: Env, ctx: ExecutionContext) =>
      handleApiRequest(req, requestEnv, ctx as any, authorizationServer.getOAuthApi(requestEnv))
  };

  const mcpServer = new OAuthResourceServer<Env, GrantProps>({
    resourceMetadata: {
      resource: mcpResource,
      authorization_servers: [origin],
      resource_name: "DeskBeacon MCP"
    },
    requiredScopes: ["deskbeacon:agent"],
    validateToken,
    handler
  });

  // ChatGPT may retain an existing OAuth client registered with resource=origin.
  // This separately validates that audience without rewriting a token's audience
  // or allowing Device grants to access MCP operations.
  const legacyAgentServer = new OAuthResourceServer<Env, GrantProps>({
    resourceMetadata: {
      resource: origin,
      authorization_servers: [origin],
      resource_name: "DeskBeacon MCP (legacy Agent audience)"
    },
    requiredScopes: ["deskbeacon:agent"],
    validateToken,
    handler
  });

  const deviceServer = new OAuthResourceServer<Env, GrantProps>({
    resourceMetadata: {
      resource: origin,
      authorization_servers: [origin],
      resource_name: "DeskBeacon Device (legacy)"
    },
    requiredScopes: ["deskbeacon:device"],
    validateToken,
    handler
  });
  return { origin, mcpResource, authorizationServer, mcpServer, legacyAgentServer, deviceServer };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const { origin, authorizationServer, mcpServer, legacyAgentServer, deviceServer } = oauthResourcesFor(env, request);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", service: "deskbeacon-server" });
    }
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env, authorizationServer.getOAuthApi(env));
    }
    // Route resource discovery explicitly: the legacy root metadata and
    // the /mcp metadata are separate documents with separate token audiences.
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return mcpServer.fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      // A previously registered ChatGPT OAuth client still asks for resource=origin.
      // Keep accepting *only* valid Agent tokens bound to that canonical origin.
      // Tokens bound to /mcp follow the strict, original resource-server path.
      const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
      const bearerToken = match?.[1];
      if (bearerToken) {
        const legacyGrant = await authorizationServer.validateToken(origin, bearerToken, env);
        if (legacyGrant?.props?.kind === "agent" && legacyGrant.scope?.includes("deskbeacon:agent")) {
          return legacyAgentServer.fetch(request, env, ctx);
        }
      }
      return mcpServer.fetch(request, env, ctx);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname.startsWith("/device/")) {
      return deviceServer.fetch(request, env, ctx);
    }
    return authorizationServer.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
