import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fetch, {type RequestInit} from 'node-fetch';
import {ProxyAgent} from 'proxy-agent';
import {WebSocket, type ClientOptions} from 'ws';

const execFileAsync=promisify(execFile);
export type ProxySettings={proxyAuto:boolean;proxyUrl:string|null};
export type ProxyDecision={proxy:string;source:'manual'|'environment'|'windows'|'macos'|'gnome'|'android'|'disabled'|'direct'|'bypass'};
const cache=new Map<string,{expires:number;proxy:string}>();
const TTL=15_000;

export function validateProxyUrl(value:string):string{
 const trimmed=value.trim();
 if(!trimmed)throw Error('代理地址不能为空；清除代理请使用 null');
 let parsed:URL;
 try{parsed=new URL(trimmed);}catch{throw Error('代理地址无效，示例：http://127.0.0.1:7890');}
 if(!['http:','https:','socks:','socks4:','socks4a:','socks5:','socks5h:','pac+http:','pac+https:'].includes(parsed.protocol)||
    !parsed.hostname||parsed.hash||parsed.search||(parsed.pathname!==''&&parsed.pathname!=='/'&&!parsed.protocol.startsWith('pac+')))
   throw Error('代理支持 http(s)、SOCKS 和 PAC URL，不允许无关路径或查询参数');
 return parsed.href;
}
export function redactProxy(value:string|null|undefined):string{
 if(!value)return 'DIRECT';
 try{const u=new URL(value);if(u.username||u.password){u.username='***';u.password='***';}return u.href;}
 catch{return '[invalid proxy]';}
}
export function currentProxySettings():ProxySettings{
 try{
  const path=join(process.env.DESKBEACON_DATA_DIR??join(homedir(),'.deskbeacon'),'config.json');
  const config=JSON.parse(readFileSync(path,'utf8')) as ProxySettings;
  const proxyUrl=typeof config.proxyUrl==='string'&&config.proxyUrl.trim()?config.proxyUrl:
   Object.hasOwn(config,'proxyUrl')?null:(process.env.DESKBEACON_PROXY_URL||null);
  return {proxyAuto:config.proxyAuto===true||(config.proxyAuto===undefined&&process.env.DESKBEACON_PROXY_AUTO==='1'),
   proxyUrl};
 }catch{return{proxyAuto:process.env.DESKBEACON_PROXY_AUTO==='1',proxyUrl:process.env.DESKBEACON_PROXY_URL||null};}
}
const isLocal=(u:URL)=>u.hostname==='localhost'||u.hostname==='127.0.0.1'||u.hostname==='[::1]';
const envValue=(name:string)=>process.env[name.toLowerCase()]||process.env[name.toUpperCase()]||'';
function excluded(url:URL,value:string):boolean{
 return value.split(/[\s,]+/).some(raw=>{
  if(!raw)return false;
  if(raw==='*')return true;
  const name=raw.replace(/^\*\./,'.').toLowerCase();
  const host=url.hostname.toLowerCase();
  const entry=name.replace(/:\d+$/,'');
  const port=name.match(/:(\d+)$/)?.[1];
  if(port&&port!==(url.port||(url.protocol==='https:'||url.protocol==='wss:'?'443':'80')))return false;
  return entry.startsWith('.')?host.endsWith(entry):host===entry||host.endsWith('.'+entry);
 });
}
function environmentProxy(url:URL):string{
 const envNo=envValue('no_proxy');
 if(excluded(url,envNo))return '';
 const secure=url.protocol==='https:'||url.protocol==='wss:';
 return (secure?envValue('https_proxy'):envValue('http_proxy'))||envValue('all_proxy')||
  (secure?envValue('http_proxy'):'');
}
const normalizeProxy=(value:string)=>value&&/^[a-z][\w+.-]*:\/\//i.test(value)?value:'http://'+value;
async function cached(key:string,fn:()=>Promise<string>):Promise<string>{
 const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.proxy;
 const value=await fn().catch(()=> '');cache.set(key,{expires:Date.now()+TTL,proxy:value});return value;
}
async function windowsProxy(url:URL):Promise<string>{
 const script=`$ErrorActionPreference='Stop'
try {
 $dest=[uri]$env:DESKBEACON_PROXY_TARGET
 $sys=[System.Net.WebRequest]::GetSystemWebProxy()
 if($sys.IsBypassed($dest)){[Console]::Write('DIRECT');exit}
 $p=$sys.GetProxy($dest)
 if($null -eq $p -or $p.AbsoluteUri -eq $dest.AbsoluteUri){[Console]::Write('DIRECT');exit}
 [Console]::Write($p.AbsoluteUri)
} catch {[Console]::Write('DIRECT')}`;
 return cached('windows:'+url.href,async()=>{
  const {stdout}=await execFileAsync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
   timeout:5000,windowsHide:true,maxBuffer:2048,env:{...process.env,DESKBEACON_PROXY_TARGET:url.href}});
  const result=stdout.trim();
  return result==='DIRECT'?'':result;
 });
}
async function macProxy(url:URL):Promise<string>{
 return cached('macos:'+url.protocol+':'+url.hostname,async()=>{
  const {stdout}=await execFileAsync('scutil',['--proxy'],{timeout:2500,maxBuffer:12000});
  const data=new Map<string,string>();
  for(const line of stdout.split(/\r?\n/)){
   const m=/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(line);
   if(m)data.set(m[1]!,m[2]!);
  }
  if(data.get('ProxyAutoConfigEnable')==='1'&&data.get('ProxyAutoConfigURLString'))
   return 'pac+'+data.get('ProxyAutoConfigURLString');
  const secure=url.protocol==='https:'||url.protocol==='wss:';
  const prefix=secure&&data.get('HTTPSEnable')==='1'?'HTTPS':data.get('HTTPEnable')==='1'?'HTTP':'';
  if(!prefix){
   if(data.get('SOCKSEnable')!=='1')return '';
   const socks=data.get('SOCKSProxy'),socksPort=data.get('SOCKSPort');
   return socks?`socks5://${socks}:${socksPort||'1080'}`:'';
  }
  const host=data.get(prefix+'Proxy'),port=data.get(prefix+'Port');
  return host? `http://${host}:${port||'80'}`:'';
 });
}
function gsettingsValue(s:string):string{return s.trim().replace(/^['"]|['"]$/g,'');}
async function gnomeProxy(url:URL):Promise<string>{
 return cached('gnome:'+url.protocol,async()=>{
  const query=async(schema:string,key:string)=>{
   const {stdout}=await execFileAsync('gsettings',['get',schema,key],{timeout:1400,maxBuffer:1024});return gsettingsValue(stdout);
  };
  const mode=await query('org.gnome.system.proxy','mode');
  if(mode==='auto'){
   const pac=await query('org.gnome.system.proxy','autoconfig-url');return pac?'pac+'+pac:'';
  }
  if(mode!=='manual')return '';
  const protocol=url.protocol==='https:'||url.protocol==='wss:'?'https':'http';
  const schema='org.gnome.system.proxy.'+protocol;
  const host=await query(schema,'host'),port=await query(schema,'port');
  if(!host)return '';
  return 'http://'+host+':'+(Number(port)||8080);
 });
}
async function androidProxy():Promise<string>{
 return cached('android',async()=>{
  const {stdout}=await execFileAsync('getprop',['http.proxyHost'],{timeout:1200,maxBuffer:512});
  const host=stdout.trim();if(!host)return '';
  const port=(await execFileAsync('getprop',['http.proxyPort'],{timeout:1200,maxBuffer:512})).stdout.trim();
  return 'http://'+host+':'+(Number(port)||8080);
 });
}
/** Manual URL has absolute precedence. Automatic mode checks environment first, then the OS. */
export async function resolveProxy(url:string,settings=currentProxySettings()):Promise<ProxyDecision>{
 const target=new URL(url.replace(/^ws:/,'http:').replace(/^wss:/,'https:'));
 if(settings.proxyUrl?.trim())return{proxy:validateProxyUrl(settings.proxyUrl),source:'manual'};
 if(!settings.proxyAuto)return{proxy:'',source:'disabled'};
 // Never tunnel loopback diagnostics or the OAuth callback through auto-detected proxies.
 if(isLocal(target))return{proxy:'',source:'bypass'};
 if(excluded(target,envValue('no_proxy')))return{proxy:'',source:'bypass'};
 const envProxy=environmentProxy(target);
 if(envProxy)return{proxy:validateProxyUrl(normalizeProxy(envProxy)),source:'environment'};
 const platform=process.platform;
 const pick=platform==='win32'?await windowsProxy(target):platform==='darwin'?await macProxy(target):
  platform==='android'?await androidProxy():platform==='linux'?await gnomeProxy(target).catch(()=> ''):'';
 return pick?{proxy:validateProxyUrl(normalizeProxy(pick)),source:platform==='win32'?'windows':platform==='darwin'?'macos':platform==='android'?'android':'gnome'}:
  {proxy:'',source:'direct'};
}
const agent=new ProxyAgent({getProxyForUrl:async url=>(await resolveProxy(url)).proxy});
/** All control-plane HTTP (OAuth) and device-side HTTP tool requests use one policy. */
export function networkFetch(url:string,options:RequestInit={}){
 return fetch(url,{...options,agent});
}
/** ws delegates its transport to the same async per-URL proxy resolver. */
export function networkWebSocket(url:string,options:ClientOptions={}){
 return new WebSocket(url,{...options,agent});
}
export function clearProxyCache(){cache.clear();}
