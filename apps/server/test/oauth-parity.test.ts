import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const auth = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const environment = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../../client/src/index.ts', import.meta.url), 'utf8');

describe('upstream cf-browser-mcp OAuth contract', () => {
  it('uses one upstream-style secret consent and KV rate limiting', () => {
    expect(auth).toContain('env.MCP_AUTH_SECRET');
    expect(entry).toContain('authorizationServer.getOAuthApi(env)');
    expect(auth).toContain('oauth.parseAuthRequest(request)');
    expect(auth).toContain('oauth.describeConsent(authRequest)');
    expect(auth).toContain('oauth.beginConsent(authRequest)');
    expect(auth).toContain('oauth.approveConsent(request, handle');
    expect(auth).toContain('oauth.completeAuthorization(');
    expect(auth).toContain('rateLimitKey(request)');
    expect(auth).toContain('expirationTtl: 3600');
    expect(auth).toContain('attempts >= 8');
    expect(auth).toContain('constantTimeEqual(provided, env.MCP_AUTH_SECRET)');
  });
  it('has no second owner login or PBKDF2 account/session infrastructure', () => {
    expect(auth).not.toMatch(/OWNER_LOGIN|OWNER_PASSWORD_HASH|OWNER_SESSION_SECRET|PBKDF2|LOGIN_CSRF_COOKIE|OWNER_COOKIE|handleLogin/);
    expect(environment).not.toMatch(/OWNER_LOGIN|OWNER_PASSWORD_HASH|OWNER_SESSION_SECRET|OWNER_PASSWORD/);
    expect(entry).not.toMatch(/\/login|\/consent/);
  });
  it('allows HTTPS OAuth form redirects while retaining server-side 302', () => {
    expect(auth).toContain("form-action 'self' https:");
    expect(auth).toContain('status: 302');
    expect(auth).not.toContain('allowedFormOrigin');
  });
  it('uses upstream OAuth endpoint paths for both worker and device client', () => {
    expect(entry).toContain('"/authorize"');
    expect(entry).toContain('authorizationServer.fetch(request, env, ctx)');
    expect(entry).toContain('resources: [mcpResource, origin]');
    expect(entry).toContain('refreshTokenIdleTTL: 30 * 24 * 60 * 60');
    expect(entry).toContain('clientIdMetadataDocumentEnabled: true');
    expect(entry).toContain('legacyGrantResource: origin');
    expect(entry).toContain('requiredScopes: ["deskbeacon:agent"]');
    expect(client).toContain("base+'/oauth/register'");
    expect(client).toContain("base+'/oauth/token'");
  });
});
