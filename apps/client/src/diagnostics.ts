import Rlog, {readJsonl} from 'rlog-js';
import {appendFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {diagnosticDataDir,logsDir} from './diagnostics-paths.js';
import {pruneCrashSnapshots} from './diagnostic-retention.js';
export {diagnosticDataDir,logsDir} from './diagnostics-paths.js';
const dataDir=diagnosticDataDir;
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
const MAX_SANITIZED_NODES=256;
const MAX_SANITIZED_CHARS=24*1024;
const MAX_SANITIZED_STRING=4096;
const active=new Map<LogDomain,Rlog>();
type SanitizeBudget={nodes:number;chars:number};
function sanitize(input:unknown,budget:SanitizeBudget={nodes:0,chars:0},depth=0):unknown{
 if(++budget.nodes>MAX_SANITIZED_NODES)return '[truncated]';
 if(depth>5)return '[depth-limited]';
 if(typeof input==='string'){
  const remaining=MAX_SANITIZED_CHARS-budget.chars;
  if(remaining<=0)return '[truncated]';
  const value=input.slice(0,Math.min(MAX_SANITIZED_STRING,remaining));
  budget.chars+=value.length;
  return value.replace(tokenInText,(_,bearer,prefix)=>bearer?bearer+'[redacted]':prefix+'[redacted]');
 }
 if(typeof input==='number'||typeof input==='boolean'||input===null)return input;
 if(input instanceof Error)return{type:input.name.slice(0,96),message:sanitize(input.message,budget,depth+1),stack:sanitize(input.stack??'',budget,depth+1)};
 if(Array.isArray(input))return input.slice(0,30).map(v=>sanitize(v,budget,depth+1));
 if(input&&typeof input==='object'){
  const result:Record<string,unknown>=Object.create(null);
  let count=0;
  for(const key in input){
   if(!Object.prototype.hasOwnProperty.call(input,key))continue;
   if(count>=40){result.__truncated__=true;break;}
   count++;
   const safeKey=key.slice(0,96);
   if(secrets.test(key)){result[safeKey]='[redacted]';continue;}
   try{result[safeKey]=sanitize((input as Record<string,unknown>)[key],budget,depth+1);}
   catch{result[safeKey]='[unreadable]';}
  }
  return result;
 }
 return String(input).slice(0,MAX_SANITIZED_STRING);
}
function get(domain:LogDomain):Rlog{
 const existing=active.get(domain);if(existing)return existing;
 mkdirSync(logsDir,{recursive:true,mode:0o700});
 const logger=new Rlog({
  jsonlFilePath:join(logsDir,domain+'.jsonl'),
  screenOutput:'none',jsonlLogLevel:'info',screenLogLevel:'off',
  jsonlRotation:budgets[domain],jsonlBaseFields:{domain,pid:process.pid},
  maxQueuedRecords:1024,maxQueuedBytes:1024*1024,maxRecordBytes:64*1024,
  queueOverflowPolicy:'drop-debug',
  flightRecorder:{maxRecords:128,maxBytes:128*1024,captureLevels:['debug','fatal'],includeEventData:true},
  autoRecoverFiles:{initialDelayMs:1000,maxDelayMs:60000,multiplier:2},
  fileErrorPolicy:'disable',
  redactKeys:['accessToken','refreshToken','authorization','password','secret','cookie','apiKey','dataBase64'],
  onFileError:(e,ctx)=>process.stderr.write('[DeskBeacon log failure] '+ctx.output+'.'+ctx.operation+' '+(ctx.filePath??'')+' '+e.message.slice(0,300)+'\n'),
 });
 active.set(domain,logger);return logger;
}
export function logEvent(domain:LogDomain,event:string,level:Severity='warn',details:Record<string,unknown>={}):void{
 try{get(domain).jsonl.event(event,sanitize(details) as Record<string,unknown>,{level,message:event});}
 catch(error){try{process.stderr.write('[DeskBeacon logger] '+String(error)+'\n');}catch{}}
}
/** Propagate safe operation metadata through async callbacks without letting logging setup block the operation. */
export function withLogContext<T>(domain:LogDomain,context:Record<string,unknown>,operation:()=>T):T{
 let logger:Rlog;
 try{logger=get(domain);}catch{return operation();}
 return logger.withContext(sanitize(context) as Record<string,unknown>,operation);
}
export function diagnosticsSnapshot():Partial<Record<LogDomain,{
 logger:ReturnType<Rlog['diagnostics']>;
 flightRecorder:ReturnType<Rlog['flightRecorderStatus']>;
}>>{
 const snapshot:Partial<Record<LogDomain,{
  logger:ReturnType<Rlog['diagnostics']>;
  flightRecorder:ReturnType<Rlog['flightRecorderStatus']>;
 }>>={};
 for(const [domain,logger] of active)snapshot[domain]={logger:logger.diagnostics(),flightRecorder:logger.flightRecorderStatus()};
 return snapshot;
}
export function getFlightRecorderSnapshot(domain:LogDomain):ReturnType<Rlog['flightRecorderSnapshot']>{
 return get(domain).flightRecorderSnapshot();
}
/** Export bounded in-memory context before a fatal process exit; every export is a new file. */
export async function exportFlightRecorderSnapshots(reason:string):Promise<string[]>{
 const safeReason=reason.replace(/[^a-z0-9_-]/gi,'_').slice(0,32)||'diagnostic';
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const results=await Promise.allSettled([...active.entries()].map(async([domain,logger])=>{
  if(logger.flightRecorderStatus().records===0)return null;
  const path=join(logsDir,'flight-'+safeReason+'-'+process.pid+'-'+stamp+'-'+domain+'.jsonl');
  await logger.exportFlightRecorder(path);
  return path;
 }));
 const paths:string[]=[];
 for(const result of results){
  if(result.status==='fulfilled'){if(result.value)paths.push(result.value);}
  else try{process.stderr.write('[DeskBeacon flight recorder export failure] '+String(result.reason)+'\n');}catch{}
 }
 try{pruneCrashSnapshots(paths);}catch{}
 return paths;
}
function truncateUtf8(value:string,maxBytes:number):string{
 let result=value;
 while(Buffer.byteLength(result,'utf8')>maxBytes)
  result=result.slice(0,Math.max(0,Math.floor(result.length*maxBytes/Buffer.byteLength(result,'utf8'))));
 return result;
}
/** Read a bounded tail across active and rotated JSONL files using RLog's streaming reader. */
export async function readDiagnosticLogTail(domain:LogDomain,maxBytes=18_000):Promise<string>{
 const limit=Math.max(1024,Math.min(64*1024,Math.trunc(maxBytes)));
 // readJsonl preserves order within each writer but does not promise global
 // ordering across isolated writers. Keep only the newest byte-budgeted
 // records by their timestamps, not the last writer visited by the reader.
 const tail:{timestamp:number;line:string;size:number}[]=[];
 let bytes=0;
 for await(const item of readJsonl({filePath:join(logsDir,domain+'.jsonl'),skipMalformed:true})){
  let line=JSON.stringify(item.record);
  let size=Buffer.byteLength(line,'utf8')+1;
  if(size>limit){
   const marker='… [记录过长，显示已截断]';
   line=truncateUtf8(line,limit-Buffer.byteLength(marker,'utf8')-1)+marker;
   size=Buffer.byteLength(line,'utf8')+1;
  }
  const raw=item.record.timestamp;
  const parsed=typeof raw==='number'?raw:Date.parse(String(raw??''));
  const timestamp=Number.isFinite(parsed)?parsed:0;
  let low=0,high=tail.length;
  while(low<high){
   const middle=(low+high)>>>1;
   if(tail[middle]!.timestamp<=timestamp)low=middle+1;
   else high=middle;
  }
  tail.splice(low,0,{timestamp,line,size});bytes+=size;
  while(bytes>limit&&tail.length>1)bytes-=tail.shift()!.size;
 }
 return tail.length?tail.map(entry=>entry.line).join('\n'):'No '+domain+' diagnostics recorded yet.';
}
/** Last-resort crash report: synchronous so fatal exits cannot lose it in RLog buffers. */
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
export async function syncLogs():Promise<void>{
 await Promise.allSettled([...active.values()].map(log=>log.syncFiles()));
}
export async function closeLogs():Promise<void>{
 const loggers=[...active.values()];active.clear();
 await Promise.allSettled(loggers.map(async logger=>{
  try{await logger.syncFiles();}finally{await logger.close();}
 }));
}
let captured=false,crashing=false;
export function installDiagnostics(role:'runtime'|'supervisor'|'migration'|'cli'):void{
 if(captured)return;captured=true;
 const domain:LogDomain=role==='supervisor'?'service':role==='migration'?'migration':'runtime';
 logEvent(domain,'process.started','info',{role,node:process.version,platform:process.platform,arch:process.arch});
 try{pruneCrashSnapshots();}catch{}
 const nativeWarn=console.warn.bind(console),nativeError=console.error.bind(console);
 console.warn=(...args:unknown[])=>{logEvent(domain,'console.warning','warn',{args});nativeWarn(...args);};
 console.error=(...args:unknown[])=>{logEvent(domain,'console.error','error',{args});nativeError(...args);};
 process.on('warning',warning=>{
  logEvent(domain,'process.warning','warn',{role,name:warning.name,message:warning.message,stack:warning.stack});
 });
 const fatal=(kind:string,error:unknown)=>{
  if(crashing)return;crashing=true;
  logEvent(domain,kind,'fatal',{role,error:error instanceof Error?error:new Error(String(error)),memory:process.memoryUsage(),uptimeSeconds:process.uptime()});
  const guard=setTimeout(()=>process.exit(1),3000);guard.unref();
  void (async()=>{
   await exportFlightRecorderSnapshots('crash');
   await syncLogs();
  })().finally(()=>{clearTimeout(guard);process.exit(1);});
 };
 // Deliberately preserve Node's fatal behavior: a logged unhandled rejection must not make an unhealthy service appear alive.
 process.on('uncaughtException',error=>fatal('process.uncaught_exception',error));
 process.on('unhandledRejection',reason=>fatal('process.unhandled_rejection',reason));
}
export function discardLegacyLog():void{
 try{rmSync(join(dataDir,'service.log'),{force:true});rmSync(join(dataDir,'service.log.1'),{force:true});}catch(error){
  logEvent('runtime','legacy_log.cleanup_failed','warn',{error});
 }
}
