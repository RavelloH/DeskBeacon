import {spawn} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {dataDir} from './daemon.js';
import {logEvent,installDiagnostics,flushLogs,closeLogs,discardLegacyLog} from './diagnostics.js';
import {writeSupervisorReport,type SupervisorPhase,type SupervisorReport} from './supervisor-diagnostics.js';

const supervisorLock=join(dataDir,'supervisor.lock');
const stopMarker=join(dataDir,'supervisor.stop');
const maxRestarts=8;
const restartWindowMs=60_000;

function pidAlive(pid:number):boolean{
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}
}
export function supervisorRunning():boolean{
 try{
  const {pid}=JSON.parse(readFileSync(supervisorLock,'utf8')) as {pid:number};
  return pidAlive(pid);
 }catch{return false;}
}
export function requestSupervisorStop(force=false):boolean{
 if(!supervisorRunning())return false;
 writeFileSync(stopMarker,JSON.stringify({requestedAt:Date.now(),force}),{mode:0o600});
 return true;
}
function acquireLock():number|null{
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 for(let i=0;i<3;i++){
  try{
   const fd=openSync(supervisorLock,'wx',0o600);
   const startedAt=Date.now();
   try{writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt}));}
   finally{closeSync(fd);}
   return startedAt;
  }catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   if(supervisorRunning())return null;
   rmSync(supervisorLock,{force:true});
  }
 }
 throw Error('SUPERVISOR_LOCK_UNAVAILABLE');
}
function captureWorkerDiagnostic(stream:'stdout'|'stderr',data:Buffer):void{
 // Capture warnings/errors, not arbitrary tool output or secrets from normal stdout.
 const lines=data.toString('utf8').split(/\r?\n/).filter(Boolean);
 for(const line of lines.slice(0,24))if(stream==='stderr'||/warning|error|fatal|exception|failed|timeout|unhandled|critical/i.test(line))
  logEvent('service','worker.diagnostic',/fatal|exception|unhandled|error/i.test(line)?'error':'warn',
   {stream,text:line.slice(0,2400)});
}
export type SupervisorOptions={
 workerEntry:string;
 workerArgs?:string[];
 workerEnv?:NodeJS.ProcessEnv;
 // Test fixtures can force short delays; production defaults are conservative.
 restartDelayMs?:number;
};
export async function superviseService(options:SupervisorOptions):Promise<void>{
 const startedAt=acquireLock();
 if(startedAt===null)return;
 installDiagnostics('supervisor');discardLegacyLog();
 // A previous stop marker cannot affect a newly explicitly launched service.
 rmSync(stopMarker,{force:true});
 let childPid=0,stopping=false;
 let restarts:number[]=[];
 let totalRestarts=0,phase:SupervisorPhase='starting';
 let lastExit:SupervisorReport['lastExit']=null;
 let snapshotErrorLogged=false;
 const publishStatus=()=>{
  try{
   writeSupervisorReport({startedAt,phase,workerPid:childPid||null,
     totalRestarts,restartsInWindow:restarts.length,lastExit});
   snapshotErrorLogged=false;
  }catch(error){
   if(!snapshotErrorLogged){snapshotErrorLogged=true;
    logEvent('service','supervisor.snapshot_failed','warn',{error});
   }
  }
 };
 const onSignal=()=>{stopping=true;phase='stopping';publishStatus();writeFileSync(stopMarker,String(Date.now()));};
 process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 logEvent('service','supervisor.started','info',{pid:process.pid,restartLimit:maxRestarts,restartWindowMs});
 publishStatus();
 const statusTimer=setInterval(publishStatus,15_000);
 statusTimer.unref();
 try{
  while(!stopping){
   if(existsSync(stopMarker))break;
   const worker=spawn(process.execPath,[options.workerEntry,...(options.workerArgs??['__service_run'])],{
    cwd:process.cwd(),env:options.workerEnv??process.env,windowsHide:true,
    stdio:['ignore','pipe','pipe']
   });
   childPid=worker.pid??0;
   phase='worker-running';publishStatus();
   logEvent('service','worker.spawned','info',{workerPid:childPid,supervisorPid:process.pid,attempt:restarts.length+1});
   worker.stdout?.on('data',(data:Buffer)=>captureWorkerDiagnostic('stdout',data));
   worker.stderr?.on('data',(data:Buffer)=>captureWorkerDiagnostic('stderr',data));
   const status=await new Promise<{code:number|null;signal:string|null}>(resolve=>{
    let done=false,stopRequestedAt=0;
    const finish=(code:number|null,signal:string|null)=>{
     if(done)return;done=true;clearInterval(watchStop);resolve({code,signal});
    };
    const watchStop=setInterval(()=>{
     if(stopping||existsSync(stopMarker)){
      stopping=true;
      let force=false;
      try{force=Boolean((JSON.parse(readFileSync(stopMarker,'utf8')) as {force?:boolean}).force);}catch{}
      if(!stopRequestedAt)stopRequestedAt=Date.now();
      // Give IPC shutdown its 7.5 second drain interval first.
      if(force||Date.now()-stopRequestedAt>12_000){
       try{worker.kill('SIGTERM');}catch{}
      }
     }
    },250);
    worker.once('exit',(code,signal)=>finish(code,signal));
    worker.once('error',error=>{logEvent('service','worker.spawn_error','error',{error});finish(1,null);});
   });
   childPid=0;
   lastExit={code:status.code,signal:status.signal,at:new Date().toISOString()};
   phase=stopping?'stopping':'restarting';publishStatus();
   logEvent('service','worker.exited',stopping?'info':'error',{code:status.code,signal:status.signal,expected:stopping,workerPid:worker.pid??null});
   // Only an explicit stop request ends supervision. A worker may exit 0
   // unexpectedly (including a stray IPC exit); restart it rather than
   // leaving a healthy-looking but permanently disconnected TUI behind.
   if(stopping)break;
   const now=Date.now();
   restarts=restarts.filter(time=>now-time<restartWindowMs);
   restarts.push(now);totalRestarts++;
   if(restarts.length>maxRestarts){
    phase='restart-limit';publishStatus();
    logEvent('service','supervisor.restart_limit','fatal',{restarts:restarts.length,windowMs:restartWindowMs});
    break;
   }
   const delay=options.restartDelayMs??Math.min(8_000,500*Math.pow(2,restarts.length-1));
   logEvent('service','worker.restart_scheduled','warn',{delayMs:delay,attempt:restarts.length});
   publishStatus();
   await new Promise<void>(resolve=>setTimeout(resolve,delay));
  }
 }finally{
  clearInterval(statusTimer);
  if(childPid){try{process.kill(childPid,'SIGTERM');}catch{}}
  // Preserve the terminal reason; "stopped" alone would hide the
  // restart-limit failure that caused this Supervisor to exit.
  if(phase!=='restart-limit')phase='stopped';
  publishStatus();
  logEvent('service','supervisor.stopped','info',{pid:process.pid});
  await flushLogs();await closeLogs();
  process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
  try{
   const current=JSON.parse(readFileSync(supervisorLock,'utf8')) as {pid:number};
   if(current.pid===process.pid)rmSync(supervisorLock,{force:true});
  }catch{}
  rmSync(stopMarker,{force:true});
 }
}
