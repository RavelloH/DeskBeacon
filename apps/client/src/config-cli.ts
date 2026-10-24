import {parseCommand} from './command-palette.js';
import {getConfigView,setPendingServerUrl,setProxyConfig} from './config-actions.js';
import {requestIpc} from './ipc.js';
import {redactProxy} from './outbound-network.js';

const help='用法：deskbeacon config <name|url|proxy-auto|proxy-url> [value]\n例如：deskbeacon config proxy-auto true；deskbeacon config proxy-url http://127.0.0.1:7890；deskbeacon config proxy-url null';
type Key='name'|'url'|'proxy-auto'|'proxy-url';
type ConfigState={name?:string;url?:string;activeUrl?:string;pending?:boolean;proxyAuto?:boolean;proxyUrl?:string|null};
const isOffline=(error:unknown):boolean=>{
 const code=(error as NodeJS.ErrnoException)?.code;
 return code==='ENOENT'||code==='ECONNREFUSED'||code==='ENXIO';
};
async function get():Promise<ConfigState>{
 try{return await requestIpc({action:'config-get'},2500) as ConfigState;}
 catch(error){if(!isOffline(error))throw error;return getConfigView();}
}
async function set(key:Key,value:string):Promise<ConfigState>{
 try{return await requestIpc({action:'config-set',key,value},18000) as ConfigState;}
 catch(error){
  if(!isOffline(error))throw error;
  if(key==='proxy-auto'||key==='proxy-url')return setProxyConfig(key,value);
  if(key==='name')throw Error('设备名称需要同步到服务器。请先运行 deskbeacon 或 deskbeacon service start，等待连接成功后再修改。');
  return setPendingServerUrl(value);
 }
}
/** Returns user-visible text. The TUI /config and CLI use the same parser, IPC and change semantics. */
export async function runConfigCli(args:string[]):Promise<string>{
 if(args.length===0||args[0]==='--help'||args[0]==='-h')return help;
 const parsed=parseCommand('/config '+args.join(' '));
 if('error' in parsed)throw Error(parsed.error.replace('/config', 'deskbeacon config'));
 if(parsed.id!=='config')throw Error(help);
 const key=parsed.args[0] as Key;
 if(!parsed.value){
  const cfg=await get();
  const current=key==='proxy-auto'?String(cfg.proxyAuto===true):
   key==='proxy-url'?(cfg.proxyUrl?redactProxy(cfg.proxyUrl):'null'):cfg[key];
  return key+' = '+String(current??'未配置')+
   (key==='url'&&cfg.pending?' · 待重新授权后切换':'');
 }
 const result=await set(key,parsed.value);
 if(key==='name')return '设备名称已同步：'+result.name;
 if(key==='proxy-auto')return '自动发现代理：'+String(result.proxyAuto===true)+'（手动代理非空时优先手动配置；已运行设备在下次请求或重连时使用）';
 if(key==='proxy-url')return '手动代理：'+(result.proxyUrl?redactProxy(result.proxyUrl):'null')+'（已运行设备在下次请求或重连时使用）';
 return result.pending?
  '新 URL 已暂存，当前连接不变；运行 deskbeacon setup --url '+result.url+' 重新授权后切换':
  'URL 未改变：'+result.url;
}
