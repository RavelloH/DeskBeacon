import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, GrantProps } from "./env.js";
import { normalizeActorName } from "./oauth-actor.js";

// Authorization UI, secret comparison and rate limit ported from E:/cf-browser-mcp/src/index.ts.
import { AGENT_SCOPE, DEVICE_SCOPE, scopeToGrant } from "./oauth-scopes.js";
function htmlEscape(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string, status = 200, allowedFormOrigin?: string): Response {
	const formAction = allowedFormOrigin ? `'self' ${allowedFormOrigin}` : "'self'";
	return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:620px;margin:9vh auto;padding:0 22px;color:#18202a}main{border:1px solid #d8dee8;border-radius:14px;padding:26px}label{display:block;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #98a2b3;border-radius:8px;font:inherit}button{padding:10px 16px;border:0;border-radius:8px;background:#1458d4;color:white;font:inherit;cursor:pointer}button.secondary{background:#e9edf4;color:#18202a}.error{color:#a32222}</style></head><body><main>${body}</main></body></html>`, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
			"referrer-policy": "no-referrer",
		}, status,
	});
}

function constantTimeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

async function rateLimitKey(request: Request): Promise<string> {
	const address = request.headers.get("cf-connecting-ip") ?? "unknown";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
	const bytes = new Uint8Array(digest);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `auth-fail:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export async function handleAuthorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
	if (!env.MCP_AUTH_SECRET) return new Response("MCP_AUTH_SECRET is not configured", { status: 503 });

	if (request.method === "GET") {
		try {
			const authRequest = await oauth.parseAuthRequest(request);
			const grantedScope = scopeToGrant(authRequest.scope);
			if (!grantedScope) return page("权限无效", "<h1>DeskBeacon 不支持请求的授权范围</h1>", 400);
			const details = await oauth.describeConsent(authRequest);
			const consent = await oauth.beginConsent(authRequest);
			const requestedScopes = [grantedScope];
			const scopes = requestedScopes.map((scope) => `<li>${htmlEscape(scope)}</li>`).join("");
			const scopeInputs = requestedScopes.map((scope) => `<input type="hidden" name="scope" value="${htmlEscape(scope)}">`).join("");
			const clientPublisher = details.clientDomain ? `<p>客户端域名：<strong>${htmlEscape(details.clientDomain)}</strong></p>` : `<p>此客户端没有已验证的域名，显示名称由客户端自行提供。</p>`;
			const callbackOrigin = new URL(authRequest.redirectUri).origin;
			const formActionUrl = new URL(request.url);
			const content = `<h1>授权DeskBeacon 设备访问</h1><p><strong>${htmlEscape(details.clientName)}</strong> 正在请求访问你的设备。</p>${clientPublisher}<p>OAuth 回调主机：<strong>${htmlEscape(details.redirectHost)}</strong></p>${details.redirectIsLoopback ? `<p>此客户端将在这台电脑上接收 OAuth 令牌。</p>` : ""}<p>本次授予的权限：</p><ul>${scopes}</ul><form method="post" action="${htmlEscape(`${formActionUrl.pathname}${formActionUrl.search}`)}"><input type="hidden" name="handle" value="${htmlEscape(consent.handle)}">${scopeInputs}<label for="secret">授权密钥</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><p><button name="decision" value="approve">继续授权</button> <button class="secondary" name="decision" value="deny" formnovalidate>取消</button></p></form>`;
			const response = page("授权 DeskBeacon", content, 200, callbackOrigin);
			for (const [name, value] of consent.headers) response.headers.append(name, value);
			return response;
		} catch (error) {
			return oauthErrorResponse(error);
		}
	}

	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (!handle) return page("授权失败", "<h1>授权已过期</h1><p>请从 MCP 客户端重新开始连接。</p>");
	if (form.get("decision") !== "approve") {
		try {
			const denied = await oauth.denyConsent(request, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		} catch (error) {
			return oauthErrorResponse(error);
		}
	}

	const attemptsKey = await rateLimitKey(request);
	const attempts = Number(await env.OAUTH_KV.get(attemptsKey) ?? "0");
	if (attempts >= 8) return page("授权已暂停", "<h1>尝试次数过多</h1><p>请稍后重新发起授权。</p>");
	const provided = String(form.get("secret") ?? "");
	if (!constantTimeEqual(provided, env.MCP_AUTH_SECRET)) {
		await env.OAUTH_KV.put(attemptsKey, String(attempts + 1), { expirationTtl: 3600 });
		try {
			const authRequest = await oauth.parseAuthRequest(request);
			const grantedScope = scopeToGrant(authRequest.scope);
			if (!grantedScope) return page("权限无效", "<h1>DeskBeacon 不支持请求的授权范围</h1>", 400);
			const details = await oauth.describeConsent(authRequest);
			const requestedScopes = [grantedScope];
			const scopes = requestedScopes.map((scope) => `<li>${htmlEscape(scope)}</li>`).join("");
			const scopeInputs = requestedScopes.map((scope) => `<input type="hidden" name="scope" value="${htmlEscape(scope)}">`).join("");
			const callbackOrigin = new URL(authRequest.redirectUri).origin;
			const formActionUrl = new URL(request.url);
			return page("授权密钥不正确", `<h1>授权密钥不正确</h1><p class="error">密钥不匹配，请重试或取消。</p><p><strong>${htmlEscape(details.clientName)}</strong> 正在请求访问 <strong>${htmlEscape(details.redirectHost)}</strong>。</p><p>本次授予的权限：</p><ul>${scopes}</ul><form method="post" action="${htmlEscape(`${formActionUrl.pathname}${formActionUrl.search}`)}"><input type="hidden" name="handle" value="${htmlEscape(handle)}">${scopeInputs}<label for="secret">授权密钥</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><p><button name="decision" value="approve">继续授权</button> <button class="secondary" name="decision" value="deny" formnovalidate>取消</button></p></form>`, 200, callbackOrigin);
		} catch (error) {
			return oauthErrorResponse(error);
		}
	}

	try {
		// Never grant scopes from user-editable hidden form fields. The provider
		// binds the original requested scopes to a single-use consent handle.
		const approved = await oauth.approveConsent(request, handle);
		const scope = scopeToGrant(approved.request.scope);
		if (!scope) return page("权限无效", "<h1>DeskBeacon 不支持请求的授权范围</h1>", 400);

		const client = await oauth.lookupClient(approved.request.clientId);
		const actorName = normalizeActorName(client?.clientName);
		const props: GrantProps = scope === DEVICE_SCOPE
		  ? { kind: "device", ownerId: "owner", deviceId: approved.request.clientId, deviceName: client?.clientName ?? "DeskBeacon device" }
		  : { kind: "agent", ownerId: "owner", grantId: crypto.randomUUID(), ...(actorName ? { actorName } : {}) };
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: "owner",
			metadata: { label: client?.clientName ?? "DeskBeacon" },
			scope: [scope],
			props,
		});
		await env.OAUTH_KV.delete(attemptsKey);
		approved.headers.set("location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		return oauthErrorResponse(error);
	}
}

function oauthErrorResponse(error: unknown): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
		return page("授权失败", `<h1>无法继续授权</h1><p>${htmlEscape(error.description)}</p>`, 400);
	}
	if (error instanceof CimdFetchError) return page("客户端验证失败", "<h1>无法验证客户端</h1><p>请从 MCP 客户端重新开始连接。</p>", 400);
	throw error;
}

