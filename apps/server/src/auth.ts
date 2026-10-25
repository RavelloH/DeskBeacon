import {AuthorizationError,CimdFetchError,type OAuthHelpers} from "@cloudflare/workers-oauth-provider";
import type {Env,GrantProps} from "./env.js";
import {normalizeActorName} from "./oauth-actor.js";
import {htmlEscape,page} from "./auth-page.js";
import {AGENT_SCOPE,DEVICE_SCOPE,scopeToGrant} from "./oauth-scopes.js";
import {checkSecret,guardSecretRequest} from "./security.js";

function consentForm(request:Request,details:{clientName:string;clientDomain?:string|null;redirectHost:string;redirectIsLoopback?:boolean},scope:string,handle:string,error=""):string{
 const url=new URL(request.url);
 const clientPublisher=details.clientDomain?
  '<p>客户端域名：<strong>'+htmlEscape(details.clientDomain)+'</strong></p>':
  '<p>此客户端没有已验证的域名，显示名称由客户端自行提供。</p>';
 return '<h1>授权 DeskBeacon 设备访问</h1>'+ (error?'<p class="error">'+htmlEscape(error)+'</p>':'')+
  '<p><strong>'+htmlEscape(details.clientName)+'</strong> 正在请求访问你的设备。</p>'+
  clientPublisher+'<p>OAuth 回调主机：<strong>'+htmlEscape(details.redirectHost)+'</strong></p>'+
  (details.redirectIsLoopback?'<p>此客户端将在这台电脑上接收 OAuth 令牌。</p>':'')+
  '<p>本次授予的权限：</p><ul><li>'+htmlEscape(scope)+'</li></ul>'+
  '<form method="post" action="'+htmlEscape(url.pathname+url.search)+'">'+
  '<input type="hidden" name="handle" value="'+htmlEscape(handle)+'">'+
  '<input type="hidden" name="scope" value="'+htmlEscape(scope)+'">'+
  '<label for="secret">授权密钥</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus>'+
  '<cap-widget required data-cap-api-endpoint="/cap/" data-cap-i18n-initial-state="验证后继续" data-cap-i18n-solved-label="验证完成"></cap-widget>'+
  '<p><button name="decision" value="approve">继续授权</button> '+
  '<button class="secondary" name="decision" value="deny" formnovalidate>取消</button></p></form>';
}
async function postForm(request:Request):Promise<URLSearchParams|null>{
 if(!(request.headers.get("content-type")??"").startsWith("application/x-www-form-urlencoded"))return null;
 if(Number(request.headers.get("content-length")??0)>8192)return null;
 const body=await request.text();
 if(new TextEncoder().encode(body).length>8192)return null;
 return new URLSearchParams(body);
}
export async function handleAuthorize(request:Request,env:Env,oauth:OAuthHelpers):Promise<Response>{
 if(request.method!=="GET"&&request.method!=="POST")return new Response("Method not allowed",{status:405});
 if(!env.MCP_AUTH_SECRET)return new Response("MCP_AUTH_SECRET is not configured",{status:503});
 if(request.method==="GET"){
  try{
   const parsed=await oauth.parseAuthRequest(request);
   const scope=scopeToGrant(parsed.scope);
   if(!scope)return page("权限无效","<h1>DeskBeacon 不支持请求的授权范围</h1>",400);
   const details=await oauth.describeConsent(parsed);
   const consent=await oauth.beginConsent(parsed);
   const response=page("授权 DeskBeacon",consentForm(request,details,scope,consent.handle));
   for(const [name,value] of consent.headers)response.headers.append(name,value);
   return response;
  }catch(e){return oauthErrorResponse(e);}
 }
 const form=await postForm(request);
 if(!form)return page("授权失败","<h1>表单格式不正确</h1>",400);
 const handle=form.get("handle")??"";
 if(!handle)return page("授权失败","<h1>授权已过期</h1><p>请从 MCP 客户端重新开始连接。</p>",400);
 if(form.get("decision")!=="approve"){
  try{
   const denied=await oauth.denyConsent(request,handle);
   return new Response(null,{status:302,headers:denied.headers});
  }catch(e){return oauthErrorResponse(e);}
 }
 const protectedResult=await guardSecretRequest(request,env,form.get("cap-token"));
 if(protectedResult)return protectedResult;
 if(!checkSecret(env,form.get("secret")??"")){
  try{
   const parsed=await oauth.parseAuthRequest(request);
   const scope=scopeToGrant(parsed.scope);
   if(!scope)return page("权限无效","<h1>DeskBeacon 不支持请求的授权范围</h1>",400);
   const details=await oauth.describeConsent(parsed);
   return page("授权密钥不正确",consentForm(request,details,scope,handle,"授权密钥不正确，请重试或取消。"),401);
  }catch(e){return oauthErrorResponse(e);}
 }
 try{
  const approved=await oauth.approveConsent(request,handle);
  const scope=scopeToGrant(approved.request.scope);
  if(!scope)return page("权限无效","<h1>DeskBeacon 不支持请求的授权范围</h1>",400);
  const client=await oauth.lookupClient(approved.request.clientId);
  const actorName=normalizeActorName(client?.clientName);
  const props:GrantProps=scope===DEVICE_SCOPE
   ?{kind:"device",ownerId:"owner",deviceId:approved.request.clientId}
   :{kind:"agent",ownerId:"owner",grantId:crypto.randomUUID(),...(actorName?{actorName}:{})};
  const {redirectTo}=await oauth.completeAuthorization({
   request:approved.request,userId:"owner",
   metadata:{label:client?.clientName??"DeskBeacon"},scope:[scope],props
  });
  approved.headers.set("location",redirectTo);
  return new Response(null,{status:302,headers:approved.headers});
 }catch(e){return oauthErrorResponse(e);}
}
function oauthErrorResponse(error:unknown):Response{
 if(error instanceof AuthorizationError){
  if(error.redirectTo)return Response.redirect(error.redirectTo,302);
  return page("授权失败","<h1>无法继续授权</h1><p>"+htmlEscape(error.description)+"</p>",400);
 }
 if(error instanceof CimdFetchError)return page("客户端验证失败","<h1>无法验证客户端</h1>",400);
 throw error;
}
