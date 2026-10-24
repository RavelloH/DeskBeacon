import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";
import type {Env} from "./env.js";
import {htmlEscape,page} from "./auth-page.js";

/** Authorization-code relay for a headless Device; no new OAuth token issuer. */
const TTL=300;
const INTERVAL=5;
const CODE_CHARS="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type Pending={clientId:string;codeChallenge:string;deviceName:string;state:string;expiresAt:number;status:"pending"|"approved"|"denied";code?:string};
const enc=new TextEncoder();
const rand=(bytes:number)=>{const a=crypto.getRandomValues(new Uint8Array(bytes));return btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");};
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(value)))).map(x=>x.toString(16).padStart(2,"0")).join("");
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store","referrer-policy":"no-referrer"}});
const expired=(value:Pending)=>Date.now()>=value.expiresAt;
const sessionKey=(hash:string)=>"pair:session:"+hash;
const stateKey=(state:string)=>"pair:state:"+state;
const userKey=(code:string)=>"pair:user:"+code;
const getSession=async(env:Env,hash:string)=>env.OAUTH_KV.get<Pending>(sessionKey(hash),"json");
const noStoreRedirect=(url:string)=>new Response(null,{status:303,headers:{"location":url,"cache-control":"no-store","referrer-policy":"no-referrer"}});
const normalizedCode=(value:string)=>value.toUpperCase().replace(/[\s-]/g,"");
function inputPage(message="",code=""){
 const body=`<h1>授权 DeskBeacon 设备</h1><p>输入另一台设备终端上显示的配对验证码。</p>${message?`<p class="error">${htmlEscape(message)}</p>`:""}
 <form action="/activate" method="post"><label for="code">配对验证码</label>
 <input id="code" name="code" required minlength="8" maxlength="14" autocomplete="one-time-code"
 value="${htmlEscape(code)}" placeholder="XXXX-XXXX" autofocus>
 <p><button type="submit">继续</button></p></form><p>接下来仍需要输入 DeskBeacon 管理密钥并确认授权。</p>`;
 return page("设备配对",body,message?400:200);
}
function finishedPage(approved:boolean){
 return page(approved?"授权已确认":"授权已取消",approved?
  "<h1>设备授权已确认</h1><p>请返回目标设备的终端完成配对。可以关闭此页面。</p>":
  "<h1>设备授权已取消</h1><p>设备没有获得访问权限。</p>");
}
function clientIp(request:Request){
 // These endpoints only run behind Cloudflare; never trust X-Forwarded-For.
 return request.headers.get("cf-connecting-ip")||"unknown";
}
async function rateLimit(env:Env,prefix:string,key:string,limit:number):Promise<boolean>{
 const id=prefix+":"+await digest(key);
 const n=Number(await env.OAUTH_KV.get(id)??"0");
 if(n>=limit)return false;
 await env.OAUTH_KV.put(id,String(n+1),{expirationTtl:300});
 return true; // KV limits are best-effort; edge WAF can provide stronger protection.
}
async function limitedText(request:Request,maxBytes:number):Promise<string>{
 const length=Number(request.headers.get("content-length")??"0");
 if(length>maxBytes)throw Error("BODY_TOO_LARGE");
 const reader=request.body?.getReader();
 if(!reader)return "";
 const buffers:Uint8Array[]=[];let bytes=0;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.byteLength;
   if(bytes>maxBytes){await reader.cancel();throw Error("BODY_TOO_LARGE");}
   buffers.push(value);
  }
 }finally{reader.releaseLock();}
 const all=new Uint8Array(bytes);let offset=0;
 for(const buffer of buffers){all.set(buffer,offset);offset+=buffer.byteLength;}
 return new TextDecoder().decode(all);
}
async function readBody(request:Request){
 return JSON.parse(await limitedText(request,4096)) as Record<string,unknown>;
}
async function start(request:Request,env:Env,oauth:OAuthHelpers,origin:string){
 if(!await rateLimit(env,"pair:start:ip",clientIp(request),20))return json({error:"rate_limited"},429);
 let body:Record<string,unknown>;
 try{body=await readBody(request);}catch{return json({error:"invalid_request"},400);}
 const clientId=body.client_id,challenge=body.code_challenge,name=body.device_name;
 if(typeof clientId!=="string"||clientId.length>400||
  typeof challenge!=="string"||!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)||
  typeof name!=="string"||name.length>120)return json({error:"invalid_request"},400);
 const callback=origin+"/pair/callback";
 // Only clients specifically registered for the pairing callback may start a relay.
 const client=await oauth.lookupClient(clientId).catch(()=>null);
 if(!client||!client.redirectUris.includes(callback)||
  !client.grantTypes?.includes("authorization_code")||
  client.tokenEndpointAuthMethod!=="none")return json({error:"invalid_client"},403);
 const deviceCode=rand(32),hash=await digest(deviceCode),state=rand(32);
 let raw="";
 for(let i=0;i<8;i++)raw+=CODE_CHARS[crypto.getRandomValues(new Uint8Array(1))[0]!%CODE_CHARS.length];
 const userCode=raw.slice(0,4)+"-"+raw.slice(4);
 const pending:Pending={clientId,codeChallenge:challenge,deviceName:name,state,
  expiresAt:Date.now()+TTL*1000,status:"pending"};
 await env.OAUTH_KV.put(sessionKey(hash),JSON.stringify(pending),{expirationTtl:TTL});
 await env.OAUTH_KV.put(stateKey(state),hash,{expirationTtl:TTL});
 await env.OAUTH_KV.put(userKey(raw),hash,{expirationTtl:TTL});
 return json({device_code:deviceCode,user_code:userCode,verification_uri:origin+"/activate",
  expires_in:TTL,interval:INTERVAL});
}
async function poll(request:Request,env:Env){
 // device_code is a 256-bit secret; polling is read-only to avoid KV writes every five seconds.
 let body:Record<string,unknown>;
 try{body=await readBody(request);}catch{return json({error:"invalid_request"},400);}
 const code=body.device_code;
 if(typeof code!=="string"||!/^[\w-]{40,50}$/.test(code))return json({error:"invalid_request"},400);
 const hash=await digest(code),session=await getSession(env,hash);
 if(!session||expired(session))return json({error:"expired_token"},410);
 if(session.status==="denied")return json({status:"denied"},200);
 if(session.status!=="approved"||!session.code)return json({status:"pending",interval:INTERVAL},202);
 // The OAuth provider enforces single-use of the authorization code; PKCE binds it to the CLI.
 return json({status:"authorized",code:session.code});
}
async function activate(request:Request,env:Env,origin:string){
 if(request.method==="GET")return inputPage();
 const originHeader=request.headers.get("origin");
 if(originHeader&&originHeader!==origin)return inputPage("跨站请求已被拒绝。");
 const type=request.headers.get("content-type")??"";
 if(!type.startsWith("application/x-www-form-urlencoded"))return inputPage("表单格式无效。");
 if(!await rateLimit(env,"pair:activate:ip",clientIp(request),15))return inputPage("尝试次数过多，请稍后重试。");
 const formText=await limitedText(request,1024).catch(()=>null);
 if(formText===null)return inputPage("验证码无效或已过期。");
 const raw=normalizedCode(new URLSearchParams(formText).get("code")??"");
 if(!/^[A-HJ-NP-Z2-9]{8}$/.test(raw))return inputPage("验证码无效或已过期。");
 const hash=await env.OAUTH_KV.get(userKey(raw));
 const session=hash?await getSession(env,hash):null;
 if(!session||expired(session)||session.status!=="pending")return inputPage("验证码无效或已过期。");
 const url=new URL("/authorize",origin);
 url.searchParams.set("response_type","code");
 url.searchParams.set("client_id",session.clientId);
 url.searchParams.set("redirect_uri",origin+"/pair/callback");
 url.searchParams.set("scope","deskbeacon:device");
 url.searchParams.set("resource",origin);
 url.searchParams.set("state",session.state);
 url.searchParams.set("code_challenge",session.codeChallenge);
 url.searchParams.set("code_challenge_method","S256");
 return noStoreRedirect(url.href);
}
async function callback(request:Request,env:Env){
 const url=new URL(request.url);
 const state=url.searchParams.get("state");
 if(!state||!/^[\w-]{40,50}$/.test(state))return page("配对失败","<h1>授权状态无效</h1>",400);
 const hash=await env.OAUTH_KV.get(stateKey(state));
 const session=hash?await getSession(env,hash):null;
 if(!session||expired(session)||session.state!==state||session.status!=="pending")
  return page("配对失败","<h1>配对已过期或已完成</h1>",400);
 const error=url.searchParams.get("error"),code=url.searchParams.get("code");
 if(error&&(!/^[a-z_]{1,80}$/.test(error)))return page("配对失败","<h1>授权错误无效</h1>",400);
 if(!error&&(!code||code.length<8||code.length>4096||/[\x00-\x1f\x7f]/.test(code)))return page("配对失败","<h1>授权码无效</h1>",400);
 const updated:Pending={...session,status:error?"denied":"approved",...(code?{code}:{})};
 const remaining=Math.max(1,Math.ceil((session.expiresAt-Date.now())/1000));
 await env.OAUTH_KV.put(sessionKey(hash!),JSON.stringify(updated),{expirationTtl:remaining});
 return finishedPage(!error);
}
export async function handlePairRequest(request:Request,env:Env,oauth:OAuthHelpers,origin:string):Promise<Response>{
 const url=new URL(request.url);
 const path=url.pathname,method=request.method;
 if(path==="/activate"&&(method==="GET"||method==="POST"))return activate(request,env,origin);
 if(path==="/pair/callback"&&method==="GET")return callback(request,env);
 if(path==="/pair/start"&&method==="POST")return start(request,env,oauth,origin);
 if(path==="/pair/poll"&&method==="POST")return poll(request,env);
 return new Response("Method not allowed",{status:405,headers:{"allow":path==="/activate"?"GET, POST":path==="/pair/callback"?"GET":"POST"}});
}
