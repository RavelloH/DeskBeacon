import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {saveConfig} from './daemon.js';
import {logEvent} from './diagnostics.js';

const url64=(value:Buffer)=>value.toString('base64url');
export const SETUP_PHASES=[
 '校验服务器地址',
 '启动本地授权回调',
 '注册 OAuth 客户端',
 '等待浏览器授权',
 '交换访问令牌',
 '保存设备配置',
] as const;
export type SetupStage=typeof SETUP_PHASES[number];
export type SetupProgress={stage:SetupStage;index:number;startedAt:number;server:string;authorizeUrl?:string;deviceId?:string};
export function validateSetupUrl(value:string):string{
 let url:URL;
 try{url=new URL(value.trim());}catch{throw Error('请输入有效的服务器 URL，例如 https://beacon.example.com');}
 if(!['https:','http:'].includes(url.protocol)||
  (url.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(url.hostname)))
  throw Error('服务器必须使用 HTTPS（仅 localhost / 127.0.0.1 允许 HTTP）');
 return url.origin;
}
function defaultOpenBrowser(url:string):void{
 const child=process.platform==='win32'
  ?spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore'})
  :spawn(process.platform==='darwin'?'open':'xdg-open',[url],{detached:true,stdio:'ignore'});
 child.on('error',error=>logEvent('security','oauth.browser_launch_failed','warn',{error}));
 child.unref();
}
export async function runSetupFlow(rawUrl:string,options:{
 onProgress?:(progress:SetupProgress)=>void;
 openBrowser?:(url:string)=>void;
 timeoutMs?:number;
 signal?:AbortSignal;
}={}):Promise<{deviceId:string;server:string}>{
 options.signal?.throwIfAborted();
 const startedAt=Date.now();
 let index=0,server='';
 const notify=(stage:SetupStage,detail:Pick<SetupProgress,'authorizeUrl'|'deviceId'>={})=>{
  index=SETUP_PHASES.indexOf(stage);
  options.onProgress?.({stage,index,startedAt,server,...detail});
 };
 notify(SETUP_PHASES[0]);
 server=validateSetupUrl(rawUrl);
 const codeVerifier=url64(randomBytes(32));
 const challenge=url64(createHash('sha256').update(codeVerifier).digest());
 const state=url64(randomBytes(24));
 let resolveCode!:(code:string)=>void;
 let rejectCode!:(error:Error)=>void;
 const authorizationCode=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
 notify(SETUP_PHASES[1]);
 const callback=createServer((req,res)=>{
  const params=new URL(req.url??'/',server);
  if(params.pathname!=='/callback'){res.writeHead(404);res.end();return;}
  if(params.searchParams.get('state')!==state){
   res.writeHead(403);res.end('授权状态校验失败');rejectCode(Error('OAuth 授权状态不匹配'));return;
  }
  const code=params.searchParams.get('code');
  if(!code){res.writeHead(400);res.end('缺少授权码');rejectCode(Error('OAuth 回调未提供授权码'));return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DeskBeacon 授权完成</title><body><h2>DeskBeacon 授权成功</h2><p>请返回终端等待设备配置完成。</p></body></html>');
  resolveCode(code);
 });
 try{
  await new Promise<void>((resolve,reject)=>{
   callback.once('error',reject);
   callback.listen(0,'127.0.0.1',()=>{callback.off('error',reject);resolve();});
  });
  const addr=callback.address();if(!addr||typeof addr==='string')throw Error('无法启动本地 OAuth 回调服务');
  const redirect='http://127.0.0.1:'+addr.port+'/callback';
  notify(SETUP_PHASES[2]);
  const register=await fetch(server+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({client_name:'DeskBeacon Device '+hostname(),redirect_uris:[redirect],
    token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}),signal:options.signal??null});
  if(!register.ok)throw Error('OAuth 客户端注册失败：HTTP '+register.status);
  const client=await register.json() as {client_id:string};
  if(!client.client_id)throw Error('OAuth 注册响应缺少 client_id');
  const authorize=new URL('/authorize',server);
  authorize.searchParams.set('response_type','code');
  authorize.searchParams.set('client_id',client.client_id);
  authorize.searchParams.set('redirect_uri',redirect);
  authorize.searchParams.set('scope','deskbeacon:device');
  authorize.searchParams.set('resource',server);
  authorize.searchParams.set('state',state);
  authorize.searchParams.set('code_challenge',challenge);
  authorize.searchParams.set('code_challenge_method','S256');
  notify(SETUP_PHASES[3],{authorizeUrl:authorize.href});
  (options.openBrowser??defaultOpenBrowser)(authorize.href);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let onAbort:(()=>void)|undefined;
  let code:string;
  try{
   const cancel=new Promise<never>((_,reject)=>{
    onAbort=()=>reject(Error('用户取消了设备授权'));
    options.signal?.addEventListener('abort',onAbort,{once:true});
    if(options.signal?.aborted)onAbort();
   });
   code=await Promise.race([
    authorizationCode,cancel,
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('等待浏览器授权超时，请重新运行 setup')),options.timeoutMs??180_000);}),
   ]);
  }finally{
   if(timer)clearTimeout(timer);
   if(onAbort)options.signal?.removeEventListener('abort',onAbort);
  }
  notify(SETUP_PHASES[4]);
  const token=await fetch(server+'/oauth/token',{method:'POST',signal:options.signal??null,
   headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
    grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:redirect,code_verifier:codeVerifier,
   })});
  if(!token.ok)throw Error('OAuth 令牌交换失败：HTTP '+token.status);
  const credentials=await token.json() as {access_token:string;refresh_token?:string;expires_in?:number};
  if(!credentials.access_token)throw Error('OAuth 未返回访问令牌');
  options.signal?.throwIfAborted();
  notify(SETUP_PHASES[5]);
  saveConfig({url:server,clientId:client.client_id,deviceId:client.client_id,accessToken:credentials.access_token,
   ...(credentials.refresh_token?{refreshToken:credentials.refresh_token}:{}),
   ...(credentials.expires_in?{accessTokenExpiresAt:Date.now()+credentials.expires_in*1000}:{}),
   deviceName:hostname()});
  logEvent('security','oauth.device_paired','info',{deviceId:client.client_id,server});
  return{deviceId:client.client_id,server};
 }catch(error){
  logEvent('security','oauth.setup_failed','error',{error,server});
  if(options.signal?.aborted)throw Error('用户取消了设备授权');
  throw error;
 }finally{
  if(callback.listening)await new Promise<void>(resolve=>callback.close(()=>resolve()));
 }
}
