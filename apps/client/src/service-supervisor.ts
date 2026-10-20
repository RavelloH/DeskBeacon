import {spawn} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,statSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {dataDir} from './daemon.js';

const supervisorLock=join(dataDir,'supervisor.lock');
const stopMarker=join(dataDir,'supervisor.stop');
const serviceLog=join(dataDir,'service.log');
const maxLogBytes=4*1024*1024;
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
function acquireLock():boolean{
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 for(let i=0;i<3;i++){
  try{
   const fd=openSync(supervisorLock,'wx',0o600);
   try{writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:Date.now()}));}
   finally{closeSync(fd);}
   return true;
  }catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   if(supervisorRunning())return false;
   rmSync(supervisorLock,{force:true});
  }
 }
 throw Error('SUPERVISOR_LOCK_UNAVAILABLE');
}
function log(text:string){
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 const content=text.length>65536?text.slice(0,65536)+' [log chunk truncated]\n':text;
 try{
  if(existsSync(serviceLog)&&statSync(serviceLog).size+Buffer.byteLength(content)>maxLogBytes){
   const prev=serviceLog+'.1';rmSync(prev,{force:true});
   renameSync(serviceLog,prev);
  }
  appendFileSync(serviceLog,content,{mode:0o600});
 }catch{
  // Diagnostics must never crash the runtime watchdog.
 }
}
const stamp=(event:string)=>new Date().toISOString()+' '+event+'\n';
export type SupervisorOptions={
 workerEntry:string;
 workerArgs?:string[];
 workerEnv?:NodeJS.ProcessEnv;
 // Test fixtures can force short delays; production defaults are conservative.
 restartDelayMs?:number;
};
export async function superviseService(options:SupervisorOptions):Promise<void>{
 if(!acquireLock())return;
 // A previous stop marker cannot affect a newly explicitly launched service.
 rmSync(stopMarker,{force:true});
 let childPid=0,stopping=false;
 let restarts:number[]=[];
 const onSignal=()=>{stopping=true;writeFileSync(stopMarker,String(Date.now()));};
 process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 log(stamp('supervisor started pid='+process.pid));
 try{
  while(!stopping){
   if(existsSync(stopMarker))break;
   const worker=spawn(process.execPath,[options.workerEntry,...(options.workerArgs??['__service_run'])],{
    cwd:process.cwd(),env:options.workerEnv??process.env,windowsHide:true,
    stdio:['ignore','pipe','pipe']
   });
   childPid=worker.pid??0;
   log(stamp('runtime spawned pid='+childPid));
   worker.stdout?.on('data',(data:Buffer)=>log(stamp('stdout '+data.toString('utf8'))));
   worker.stderr?.on('data',(data:Buffer)=>log(stamp('stderr '+data.toString('utf8'))));
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
    worker.once('error',error=>{log(stamp('spawn error '+String(error)));finish(1,null);});
   });
   childPid=0;
   log(stamp('runtime exit code='+status.code+' signal='+status.signal));
   // Only an explicit stop request ends supervision. A worker may exit 0
   // unexpectedly (including a stray IPC exit); restart it rather than
   // leaving a healthy-looking but permanently disconnected TUI behind.
   if(stopping)break;
   const now=Date.now();
   restarts=restarts.filter(time=>now-time<restartWindowMs);
   restarts.push(now);
   if(restarts.length>maxRestarts){
    log(stamp('fatal: runtime restart limit reached ('+restarts.length+' within '+restartWindowMs+'ms)'));
    break;
   }
   const delay=options.restartDelayMs??Math.min(8_000,500*Math.pow(2,restarts.length-1));
   log(stamp('restart scheduled delay='+delay+'ms count='+restarts.length));
   await new Promise<void>(resolve=>setTimeout(resolve,delay));
  }
 }finally{
  if(childPid){try{process.kill(childPid,'SIGTERM');}catch{}}
  log(stamp('supervisor stopped pid='+process.pid));
  process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
  try{
   const current=JSON.parse(readFileSync(supervisorLock,'utf8')) as {pid:number};
   if(current.pid===process.pid)rmSync(supervisorLock,{force:true});
  }catch{}
  rmSync(stopMarker,{force:true});
 }
}
