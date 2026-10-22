export function htmlEscape(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function page(title: string, body: string, status = 200): Response {
	return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:620px;margin:9vh auto;padding:0 22px;color:#18202a}main{border:1px solid #d8dee8;border-radius:14px;padding:26px}label{display:block;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #98a2b3;border-radius:8px;font:inherit}button{padding:10px 16px;border:0;border-radius:8px;background:#1458d4;color:white;font:inherit;cursor:pointer}button.secondary{background:#e9edf4;color:#18202a}.error{color:#a32222}</style></head><body><main>${body}</main></body></html>`, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'`,
			"referrer-policy": "no-referrer",
		}, status,
	});
}
