import {chmodSync,existsSync,lstatSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {diagnosticDataDir} from './diagnostics-paths.js';
import {diagnosticsSnapshot} from './diagnostics.js';

const statusPath=join(diagnosticDataDir,'supervisor-diagnostics.json');
const lockPath=join(diagnosticDataDir,'supervisor.lock');
export type SupervisorPhase='starting'|'worker-running'|'restarting'|'stopping'|'stopped'|'restart-limit';
export type SupervisorReport={
 schemaVersion:1;scope:'supervisor';pid:number;startedAt:number;capturedAt:string;
 phase:SupervisorPhase;workerPid:number|null;totalRestarts:number;restartsInWindow:number;
 lastExit:{code:number|null;signal:string|null;at:string}|null;
 memoryRssBytes:number;
 logger:{
  queuedRecords:number;queuedBytes:number;droppedRecords:number;fileErrors:number;
  sinkActive:{text:boolean;jsonl:boolean};recoveryAttempts:number;recoverySuccesses:number;
  flightRecords:number;flightBytes:number;
 }|null;
};
export type SupervisorRead=SupervisorReport&{running:boolean;fresh:boolean;ageMs:number};

export function writeSupervisorReport(input:{
 startedAt:number;phase:SupervisorPhase;workerPid:number|null;totalRestarts:number;
 restartsInWindow:number;lastExit:SupervisorReport['lastExit'];
}):void{
 const snapshot=diagnosticsSnapshot().service;
 const log=snapshot?.logger,flight=snapshot?.flightRecorder;
 const report:SupervisorReport={
  schemaVersion:1,scope:'supervisor',pid:process.pid,startedAt:input.startedAt,
  capturedAt:new Date().toISOString(),phase:input.phase,workerPid:input.workerPid,
  totalRestarts:input.totalRestarts,restartsInWindow:input.restartsInWindow,
  lastExit:input.lastExit,memoryRssBytes:process.memoryUsage().rss,
  logger:log&&flight?{
   queuedRecords:log.queuedRecords,queuedBytes:log.queuedBytes,
   droppedRecords:log.droppedRecords,fileErrors:log.fileErrors,
   sinkActive:log.sinkActive,recoveryAttempts:log.recovery.jsonl.attempts,
   recoverySuccesses:log.recovery.jsonl.successes,
   flightRecords:flight.records,flightBytes:flight.bytes
  }:null
 };
 const temporary=statusPath+'.'+process.pid+'.'+randomUUID()+'.tmp';
 try{
  writeFileSync(temporary,JSON.stringify(report),{flag:'wx',mode:0o600});
  renameSync(temporary,statusPath);
  if(process.platform!=='win32')chmodSync(statusPath,0o600);
 }finally{try{rmSync(temporary,{force:true});}catch{}}
}
function alive(pid:number):boolean{
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true;}
 catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
/** Best-effort read; never treats a stale status file as an active supervisor. */
export function readSupervisorReport():SupervisorRead|null{
 try{
  const stat=lstatSync(statusPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024)return null;
  const value=JSON.parse(readFileSync(statusPath,'utf8')) as SupervisorReport;
  if(value?.schemaVersion!==1||value.scope!=='supervisor'||
     !Number.isSafeInteger(value.pid)||!Number.isSafeInteger(value.startedAt)||
     !Number.isSafeInteger(value.totalRestarts)||!Number.isSafeInteger(value.restartsInWindow)||
     typeof value.phase!=='string'||typeof value.capturedAt!=='string')return null;
  const ageMs=Math.max(0,Date.now()-Date.parse(value.capturedAt));
  let running=false;
  if(existsSync(lockPath)){
   const lock=JSON.parse(readFileSync(lockPath,'utf8')) as {pid:number;startedAt:number};
   running=lock.pid===value.pid&&lock.startedAt===value.startedAt&&alive(value.pid);
  }
  return {...value,running,fresh:running&&Number.isFinite(ageMs)&&ageMs<45_000,ageMs};
 }catch{return null;}
}
