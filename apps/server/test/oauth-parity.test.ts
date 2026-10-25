import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const auth = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
const authPage = readFileSync(new URL('../src/auth-page.ts', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const environment = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../../client/src/setup-flow.ts', import.meta.url), 'utf8');

describe('upstream cf-browser-mcp OAuth contract', () => {
  it('validates CapJS proof before secret and completes server-bound OAuth consent', () => {
    expect(entry).toContain('authorizationServer.getOAuthApi(env)');
    expect(auth).toContain('oauth.parseAuthRequest(request)');
    expect(auth).toContain('oauth.describeConsent(parsed)');
    expect(auth).toContain('oauth.beginConsent(parsed)');
    expect(auth).toContain('oauth.approveConsent(request,handle)');
    expect(auth).toContain('oauth.completeAuthorization(');
    expect(auth).toContain('guardSecretRequest(request,env,form.get("cap-token"))');
    expect(auth).toContain('checkSecret(env,form.get("secret")');
    expect(auth).not.toContain('OAUTH_KV');
    expect(auth).not.toContain('rateLimitKey');
  });
  it('has no second owner login or PBKDF2 account/session infrastructure', () => {
    expect(auth).not.toMatch(/OWNER_LOGIN|OWNER_PASSWORD_HASH|OWNER_SESSION_SECRET|PBKDF2|LOGIN_CSRF_COOKIE|OWNER_COOKIE|handleLogin/);
    expect(environment).not.toMatch(/OWNER_LOGIN|OWNER_PASSWORD_HASH|OWNER_SESSION_SECRET|OWNER_PASSWORD/);
    expect(entry).not.toMatch(/\/login|\/consent/);
  });
  it('allows HTTPS and exact loopback OAuth redirects while retaining server-side 302', () => {
    expect(authPage).toContain("form-action 'self' https: http://127.0.0.1:*");
    expect(auth).toContain('status:302');
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
    expect(client).toContain("server+'/oauth/register'");
    expect(client).toContain("server+'/oauth/token'");
  });
});
