import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";
import type {Env,DeviceRecord} from "./env.js";
import {page} from "./auth-page.js";
import {guardSecretRequest,checkSecret,issueManagementToken,isManager,boundedRequestBody,strictOrigin} from "./security.js";

const json=(value:unknown,status=200)=>Response.json(value,{
 status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}
});
const html=[
'<h1>DeskBeacon 授权管理</h1><p>查看并撤销已授权的 Agent 和 Device。</p>',
'<section id="login"><form id="login-form"><label for="secret">管理员密钥</label>',
'<input id="secret" name="secret" type="password" autocomplete="current-password" required>',
'<cap-widget id="admin-cap" required data-cap-api-endpoint="/cap/" data-cap-i18n-initial-state="验证后继续" data-cap-i18n-solved-label="验证完成"></cap-widget>',
'<p><button type="submit">进入管理页面</button></p></form></section>',
'<section id="dashboard" hidden><p><button id="refresh" type="button">刷新列表</button> ',
'<button class="secondary" id="logout" type="button">退出</button></p>',
'<nav><button id="tab-agents" type="button">Agents</button> <button id="tab-devices" type="button">Devices</button></nav>',
'<div id="grants"></div><p id="next-wrap" hidden><button id="load-more" type="button">加载更多</button></p></section>',
'<p id="message" role="status"></p><script src="/assets/manage.js" defer></script>'
].join("");
export async function manageRoute(request:Request,env:Env,oauth:OAuthHelpers):Promise<Response>{
 const url=new URL(request.url),path=url.pathname;
 if(path==="/manage"&&request.method==="GET")return page("DeskBeacon 授权管理",html);
 if(path==="/manage/token"&&request.method==="POST"){
  if(!env.MCP_AUTH_SECRET)return json({error:"secret_unconfigured"},503);
  let body:Record<string,unknown>;
  try{body=await boundedRequestBody(request,8192);}catch{return json({error:"invalid_body"},400);}
  const protectedResponse=await guardSecretRequest(request,env,body.capToken);
  if(protectedResponse)return protectedResponse;
  if(typeof body.secret!=="string"||!checkSecret(env,body.secret))return json({error:"invalid_credentials"},401);
  return json(await issueManagementToken(env));
 }
 if(!path.startsWith("/manage/api/"))return json({error:"not_found"},404);
 const token=/^Bearer\s+([^\s]+)$/i.exec(request.headers.get("authorization")??"")?.[1]??"";
 if(!await isManager(env,token))return json({error:"unauthorized"},401);
 if(!strictOrigin(request))return json({error:"invalid_origin"},403);
 if(path==="/manage/api/grants"&&request.method==="GET"){
  const role=url.searchParams.get("role");
  if(role!=="agent"&&role!=="device")return json({error:"invalid_role"},400);
  const cursor=url.searchParams.get("cursor")??undefined;
  if(cursor&&cursor.length>1024)return json({error:"invalid_cursor"},400);
  const result=await oauth.listUserGrants("owner",{limit:100,...(cursor?{cursor}:{})});
  const grants=result.items.filter(g=>g.scope.includes("deskbeacon:"+role));
  const items=await Promise.all(grants.map(async g=>{
   const label=typeof g.metadata?.label==="string"?g.metadata.label:g.clientId;
   if(role==="agent")return {id:g.id,clientId:g.clientId,label,scope:g.scope,createdAt:g.createdAt,expiresAt:g.expiresAt??null};
   const record=await env.OAUTH_KV.get<DeviceRecord>("device:"+g.clientId,"json");
   const status=await env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(g.clientId))
     .fetch("https://device.internal/status").then(r=>r.json() as Promise<{online:boolean}>).catch(()=>({online:false}));
   return {id:g.id,clientId:g.clientId,label:record?.label??label,scope:g.scope,
     createdAt:g.createdAt,expiresAt:g.expiresAt??null,online:status.online};
  }));
  return json({items,cursor:result.cursor??null});
 }
 const revoke=/^\/manage\/api\/grants\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
 if(revoke&&request.method==="DELETE"){
  const grantId=revoke[1]!;
  let cursor:string|undefined;
  let owned:Awaited<ReturnType<OAuthHelpers["listUserGrants"]>>["items"][number]|undefined;
  for(let n=0;n<30;n++){
   const result=await oauth.listUserGrants("owner",{limit:1000,...(cursor?{cursor}:{})});
   owned=result.items.find(x=>x.id===grantId);
   if(owned||!result.cursor)break;
   cursor=result.cursor;
  }
  if(!owned)return json({error:"grant_not_found"},404);
  await oauth.revokeGrant(grantId,"owner");
  if(owned.scope.includes("deskbeacon:device")){
   await env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName(owned.clientId))
     .fetch("https://device.internal/revoke",{method:"POST"});
  }
  return json({revoked:true});
 }
 return json({error:"not_found"},404);
}
