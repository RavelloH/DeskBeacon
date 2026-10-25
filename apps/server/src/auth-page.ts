export function htmlEscape(value: unknown): string {
 return String(value??"").replace(/[&<>"']/g,char=>"&#"+char.charCodeAt(0)+";");
}
export function page(title:string,body:string,status=200):Response{
 const scripts=body.includes("<cap-widget")
 ? '<script src="/assets/cap-config.js" defer></script><script src="/assets/cap.min.js" defer></script>'
 : "";
 const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+
 htmlEscape(title)+'</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:720px;margin:7vh auto;padding:0 22px;color:#18202a}main{border:1px solid #d8dee8;border-radius:14px;padding:26px}label{display:block;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #98a2b3;border-radius:8px;font:inherit}button{padding:10px 16px;border:0;border-radius:8px;background:#1458d4;color:white;font:inherit;cursor:pointer}button.secondary{background:#e9edf4;color:#18202a}.error{color:#a32222}article{padding:12px 0;border-top:1px solid #ddd}button{margin:4px}section[hidden]{display:none}nav{display:flex;gap:8px}cap-widget{display:block;margin:16px 0}</style></head><body><main>'+body+'</main>'+scripts+'</body></html>';
 return new Response(html,{status,headers:{
  "content-type":"text/html; charset=utf-8",
  "cache-control":"no-store",
  "x-content-type-options":"nosniff",
  "content-security-policy":"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; worker-src blob:; form-action 'self' https: http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy":"no-referrer"
 }});
}
