import OAuthProvider, { getOAuthApi, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import type { Env, GrantProps } from './env.js';

const AGENT_SCOPE = 'deskbeacon:agent';
const DEVICE_SCOPE = 'deskbeacon:device';
const OWNER_COOKIE = 'deskbeacon_owner';
const LOGIN_CSRF_COOKIE = 'deskbeacon_login_csrf';
const OWNER_ID = 'owner';
const encoder = new TextEncoder();

export function oauthOptionsFor(env: Env): OAuthProviderOptions<Env> {
  const base = new URL(env.PUBLIC_BASE_URL);
  return {
  apiRoute: ['/mcp', '/device/'],
  apiHandler: { fetch: (request, env, ctx) => import('./api.js').then(({ handleApiRequest }) => handleApiRequest(request, env, ctx as any)) },
  defaultHandler: { fetch: (request, env) => handlePublicRequest(request, env) },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  resourceMetadata: {
    resource: base.origin,
    authorization_servers: [base.origin],
    bearer_methods_supported: ['header'],
    resource_name: 'DeskBeacon',
  },
  scopesSupported: [AGENT_SCOPE, DEVICE_SCOPE],
  requiredScopes: [],
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  cookiePrefix: '__Host-deskbeacon-',
  allowPrivateUseRedirectUris: false,
  disallowPublicClientRegistration: false,
  };
}

export async function handlePublicRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return Response.json({ status: 'ok', service: 'deskbeacon-server' });
  }
  if (url.pathname === '/login') return handleLogin(request, env);
  if (url.pathname === '/authorize') return handleAuthorize(request, env);
  if (url.pathname === '/consent' && request.method === 'POST') return handleConsent(request, env);
  return new Response('Not found', { status: 404 });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const oauth = getOAuthApi(oauthOptionsFor(env), env);
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch {
    return new Response('Invalid OAuth authorization request', { status: 400 });
  }
  if (!scopesAreValid(authRequest.scope)) return new Response('Exactly one DeskBeacon scope is required', { status: 400 });
  if (!(await readOwnerSession(request, env))) {
    const returnTo = `${urlPath(request)}${new URL(request.url).search}`;
    return Response.redirect(`${new URL('/login', request.url)}?returnTo=${encodeURIComponent(returnTo)}`, 302);
  }

  const [description, transaction] = await Promise.all([
    oauth.describeConsent(authRequest),
    oauth.beginConsent(authRequest),
  ]);
  const allowedScopes = authRequest.scope.filter((scope) => scope === AGENT_SCOPE || scope === DEVICE_SCOPE);
  const scopeInputs = allowedScopes.map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`).join('');
  const html = page('Authorize DeskBeacon', `<h1>Authorize DeskBeacon</h1><p><b>${escapeHtml(description.clientName)}</b> requests access for <code>${escapeHtml(description.redirectHost)}</code>.</p><form method="post" action="/consent"><input type="hidden" name="handle" value="${escapeHtml(transaction.handle)}">${scopeInputs}<div><button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></div></form>`);
  const headers = new Headers(transaction.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(html, { headers });
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return new Response('Origin rejected', { status: 403 });
  if (!(await readOwnerSession(request, env))) return new Response('Sign-in required', { status: 401 });
  const form = await request.formData();
  const handle = form.get('handle');
  if (typeof handle !== 'string' || handle.length > 512) return new Response('Invalid consent handle', { status: 400 });
  const oauth = getOAuthApi(oauthOptionsFor(env), env);
  if (form.get('decision') === 'deny') {
    const denied = await oauth.denyConsent(request, handle);
    const headers = new Headers(denied.headers);
    headers.set('location', denied.redirectTo);
    return new Response(null, { status: 302, headers });
  }
  const selected = form.getAll('scope').filter((value): value is string => typeof value === 'string');
  if (!scopesAreValid(selected)) {
    return new Response('Choose exactly one supported scope', { status: 400 });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: selected });
  if (selected.some((scope) => !approved.request.scope.includes(scope))) return new Response('Consent scope was modified', { status: 400 });
  const grantKind = selected[0] === DEVICE_SCOPE ? 'device' : 'agent';
  const client = await oauth.lookupClient(approved.request.clientId);
  const props: GrantProps = grantKind === 'device'
    ? { kind: 'device', ownerId: OWNER_ID, deviceId: approved.request.clientId, deviceName: client?.clientName ?? 'DeskBeacon device' }
    : { kind: 'agent', ownerId: OWNER_ID, grantId: crypto.randomUUID() };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER_ID,
    metadata: { label: client?.clientName ?? (grantKind === 'device' ? 'DeskBeacon device' : 'DeskBeacon agent') },
    scope: selected,
    props,
    revokeExistingGrants: false,
  });
  const headers = new Headers(approved.headers);
  headers.set('location', redirectTo);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = validReturnPath(url.searchParams.get('returnTo') ?? '/authorize');
  if (request.method === 'GET') {
    const csrf = crypto.randomUUID();
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(LOGIN_CSRF_COOKIE, csrf, request, 600, false));
    return new Response(page('DeskBeacon sign in', `<h1>DeskBeacon owner sign in</h1><form method="post" action="/login"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label>Owner <input name="username" autocomplete="username" required></label><label>Password <input type="password" name="password" autocomplete="current-password" required></label><button>Sign in</button></form>`), { headers });
  }
  if (request.method !== 'POST' || !sameOrigin(request)) return new Response('Request rejected', { status: 403 });
  const form = await request.formData();
  const csrfCookie = parseCookies(request).get(LOGIN_CSRF_COOKIE);
  const csrfField = form.get('csrf');
  if (!csrfCookie || typeof csrfField !== 'string' || csrfCookie !== csrfField) return new Response('CSRF validation failed', { status: 403 });
  const username = form.get('username');
  const password = form.get('password');
  if (username !== env.OWNER_LOGIN || typeof password !== 'string' || !(await verifyPassword(password, env.OWNER_PASSWORD_HASH))) {
    return new Response(page('Sign in failed', '<h1>Sign in failed</h1><p>Check the owner credentials and try again.</p>'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const session = await createOwnerSession(env);
  const headers = new Headers({ location: validReturnPath(String(form.get('returnTo') ?? returnTo)), 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(OWNER_COOKIE, session, request, 8 * 60 * 60, true));
  headers.append('set-cookie', cookie(LOGIN_CSRF_COOKIE, '', request, 0, false));
  return new Response(null, { status: 302, headers });
}

async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  if (!encoded || password.length > 4096) return false;
  const [algorithm, countText, saltText, expectedText] = encoded.split('$');
  const iterations = Number(countText);
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000 || !saltText || !expectedText) return false;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(saltText).buffer as ArrayBuffer, iterations }, key, 256);
    return constantTimeEqual(new Uint8Array(bits), fromBase64Url(expectedText));
  } catch {
    return false;
  }
}

async function createOwnerSession(env: Env): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ uid: OWNER_ID, exp: Date.now() + 8 * 60 * 60 * 1000 })));
  return `${payload}.${await sign(payload, env)}`;
}

async function readOwnerSession(request: Request, env: Env): Promise<boolean> {
  const value = parseCookies(request).get(OWNER_COOKIE);
  if (!value) return false;
  const [payload, signature, ...extra] = value.split('.');
  if (!payload || !signature || extra.length || !(await verify(payload, signature, env))) return false;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { uid: string; exp: number };
    return session.uid === OWNER_ID && session.exp > Date.now();
  } catch {
    return false;
  }
}

async function sign(value: string, env: Env): Promise<string> {
  const secret = env.OWNER_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('OWNER_SESSION_SECRET must be at least 32 characters');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function verify(value: string, signature: string, env: Env): Promise<boolean> {
  try {
    const secret = env.OWNER_SESSION_SECRET;
    if (!secret || secret.length < 32) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, fromBase64Url(signature).buffer as ArrayBuffer, encoder.encode(value));
  } catch {
    return false;
  }
}

function scopesAreValid(scopes: string[]): boolean {
  return scopes.length === 1 && (scopes[0] === AGENT_SCOPE || scopes[0] === DEVICE_SCOPE);
}

function urlPath(request: Request): string {
  return new URL(request.url).pathname;
}

function validReturnPath(path: string): string {
  return path.startsWith('/authorize?') && !path.startsWith('//') ? path : '/authorize';
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(request.url).origin;
}

function parseCookies(request: Request): Map<string, string> {
  return new Map((request.headers.get('cookie') ?? '').split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

function cookie(name: string, value: string, request: Request, maxAge: number, httpOnly: boolean): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}${secure}`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}form,label{display:grid;gap:.75rem;margin:1rem 0}button{padding:.6rem 1rem}</style><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
