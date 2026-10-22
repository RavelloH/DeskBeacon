import Rlog from 'rlog-js';
import {appendFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
export const diagnosticDataDir=process.env.DESKBEACON_DATA_DIR??join(homedir(),'.deskbeacon');
const dataDir=diagnosticDataDir;

export const logsDir=join(dataDir,'logs');
export type LogDomain='service'|'runtime'|'connection'|'execution'|'migration'|'security'|'tui';
export type Severity='debug'|'info'|'warn'|'error'|'fatal';
const budgets:Record<LogDomain,{maxBytes:number;maxFiles:number}>={
 service:{maxBytes:2*1024*1024,maxFiles:3},
 runtime:{maxBytes:4*1024*1024,maxFiles:3},
 connection:{maxBytes:2*1024*1024,maxFiles:3},
 execution:{maxBytes:4*1024*1024,maxFiles:3},
 migration:{maxBytes:2*1024*1024,maxFiles:2},
 security:{maxBytes:2*1024*1024,maxFiles:3},
 tui:{maxBytes:2*1024*1024,maxFiles:2},
};
const secrets=/token|secret|password|authorization|cookie|privatekey|private_key|apikey|api_key|dataBase64|refresh|credential/i;
const tokenInText=/(Bearer\s+)[a-z0-9._~+/-]+|((?:access_token|refresh_token|client_secret|authorization|password|api[_-]?key)\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;
const active=new Map<LogDomain,Rlog>();
function sanitize(input:unknown,depth=0):unknown{
 if(depth>5)return '[depth-limited]';
 if(typeof input==='string')return input.slice(0,6000).replace(tokenInText,(_,bearer,prefix)=>bearer?bearer+'[redacted]':prefix+'[redacted]');
 if(typeof input==='number'||typeof input==='boolean'||input===null)return input;
 if(input instanceof Error)return{type:input.name,message:sanitize(input.message),stack:sanitize(input.stack??'')};
 if(Array.isArray(input))return input.slice(0,30).map(v=>sanitize(v,depth+1));
 if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).slice(0,40).map(([k,v])=>[k,secrets.test(k)?'[redacted]':sanitize(v,depth+1)]));
 return String(input);
}
function get(domain:LogDomain):Rlog{
 const existing=active.get(domain);if(existing)return existing;
 mkdirSync(logsDir,{recursive:true,mode:0o700});
 const logger=new Rlog({
  jsonlFilePath:join(logsDir,domain+'.jsonl'),
  screenOutput:'none',jsonlLogLevel:'info',screenLogLevel:'off',
  jsonlRotation:budgets[domain],jsonlBaseFields:{domain,pid:process.pid},
  fileErrorPolicy:'stderr',
  redactKeys:['accessToken','refreshToken','authorization','password','secret','cookie','apiKey','dataBase64'],
  onFileError:(e,ctx)=>process.stderr.write('[DeskBeacon log failure] '+ctx.operation+' '+e.message.slice(0,300)+'\n'),
 });
 active.set(domain,logger);return logger;
}
export function logEvent(domain:LogDomain,event:string,level:Severity='warn',details:Record<string,unknown>={}):void{
 try{get(domain).jsonl.event(event,sanitize(details) as Record<string,unknown>,{level,message:event});}
 catch(error){try{process.stderr.write('[DeskBeacon logger] '+String(error)+'\n');}catch{}}
}
/** Last-resort crash report: synchronous so fatal exits cannot lose it in RLog buffers.
 * This is deliberately limited to fatal events and termination signals.
 */
export function logCriticalTuiSync(event:string,details:Record<string,unknown>):void{
 try{
  mkdirSync(logsDir,{recursive:true,mode:0o700});
  const record={schema:'rlog.record',version:1,domain:'tui',pid:process.pid,
   timestamp:new Date().toISOString(),level:'fatal',message:event,
   args:[event],context:{},meta:{},event:{type:event,data:sanitize(details)}};
  appendFileSync(join(logsDir,'tui.jsonl'),JSON.stringify(record)+'\n',{encoding:'utf8',mode:0o600});
 }catch(error){
  try{process.stderr.write('[DeskBeacon fatal TUI log failure] '+String(error)+'\n');}catch{}
 }
}
export async function flushLogs():Promise<void>{
 await Promise.allSettled([...active.values()].map(log=>log.flush()));
}
export async function closeLogs():Promise<void>{
 const loggers=[...active.values()];active.clear();
 await Promise.allSettled(loggers.map(logger=>logger.close()));
}
let captured=false,crashing=false;
export function installDiagnostics(role:'runtime'|'supervisor'|'migration'|'cli'):void{
 if(captured)return;captured=true;
 const domain:LogDomain=role==='supervisor'?'service':role==='migration'?'migration':'runtime';
 logEvent(domain,'process.started','info',{role,node:process.version,platform:process.platform,arch:process.arch});
 const nativeWarn=console.warn.bind(console),nativeError=console.error.bind(console);
 console.warn=(...args:unknown[])=>{logEvent(domain,'console.warning','warn',{args});nativeWarn(...args);};
 console.error=(...args:unknown[])=>{logEvent(domain,'console.error','error',{args});nativeError(...args);};
 process.on('warning',warning=>{
  logEvent(domain,'process.warning','warn',{role,name:warning.name,message:warning.message,stack:warning.stack});
 });
 const fatal=(kind:string,error:unknown)=>{
  if(crashing)return;crashing=true;
  logEvent(domain,kind,'fatal',{role,error:error instanceof Error?error:new Error(String(error)),memory:process.memoryUsage(),uptimeSeconds:process.uptime()});
  const guard=setTimeout(()=>process.exit(1),1500);guard.unref();
  void flushLogs().finally(()=>{clearTimeout(guard);process.exit(1);});
 };
 // Deliberately preserve Node's fatal behavior: a logged unhandled rejection must not make an unhealthy service appear alive.
 process.on('uncaughtException',error=>fatal('process.uncaught_exception',error));
 process.on('unhandledRejection',reason=>fatal('process.unhandled_rejection',reason));
}
export function discardLegacyLog():void{
 try{rmSync(join(dataDir,'service.log'),{force:true});rmSync(join(dataDir,'service.log.1'),{force:true});}catch(error){
  logEvent('runtime','legacy_log.cleanup_failed','warn',{error});}
}
