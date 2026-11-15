import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

export type LockRecord={pid:number;startedAt?:number;processStartedAt?:number;purpose?:'runtime'|'supervisor'};
export function ownLockRecord(purpose:'runtime'|'supervisor'):LockRecord{
 return {pid:process.pid,startedAt:Date.now(),processStartedAt:Date.now()-process.uptime()*1000,purpose};
}
type ProcessIdentity={startedAt:number;name:string;command:string};
function queryProcess(pid:number):ProcessIdentity|null{
 if(process.platform==='linux'){
  try{
   const raw=readFileSync('/proc/'+pid+'/stat','utf8');
   const closing=raw.lastIndexOf(')');
   if(closing<0)throw Error('invalid proc stat');
   const fields=raw.slice(closing+2).trim().split(/\s+/);
   // /proc/PID/stat field 22 (starttime) is index 19 after the command name.
   const startTicks=Number(fields[19]);
   const uptime=Number(readFileSync('/proc/uptime','utf8').split(/\s+/)[0]);
   if(!Number.isFinite(startTicks)||!Number.isFinite(uptime))throw Error('invalid proc uptime');
   const startedAt=Date.now()-(uptime-startTicks/100)*1000;
   const command=readFileSync('/proc/'+pid+'/cmdline','utf8').replace(/\0/g,' ');
   return {startedAt,name:raw.slice(raw.indexOf('(')+1,closing),command};
  }catch{/* procfs may be restricted in Android; try ps instead. */}
 }
 if(process.platform==='win32'){
  const script='$p=Get-CimInstance Win32_Process -Filter "ProcessId = '+pid+'" -ErrorAction Stop;'+
   'if($null -ne $p){Write-Output $p.Name;Write-Output $p.CreationDate.ToUniversalTime().ToString("o");Write-Output $p.CommandLine}';
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
   {encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384});
  if(result.error||result.status!==0)return null;
  const lines=(result.stdout??'').split(/\r?\n/);
  if(!lines[0]||!lines[1])return null;
  const startedAt=Date.parse(lines[1]);
  return Number.isFinite(startedAt)?{startedAt,name:lines[0],command:lines.slice(2).join(' ')}:null;
 }
 // The procfs cmdline and stat metadata are reliable when available; the
 // portable ps path also covers macOS and other Unix variants.
 const result=spawnSync('ps',['-p',String(pid),'-o','lstart=','-o','comm=','-o','args='],
  {encoding:'utf8',timeout:3000,maxBuffer:16384,env:{...process.env,LC_ALL:'C'}});
 if(result.error||result.status!==0)return null;
 const row=(result.stdout??'').trim();
 const match=/^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s*(.*)$/.exec(row);
 if(!match)return null;
 const startedAt=Date.parse(match[1]!);
 return Number.isFinite(startedAt)?{startedAt,name:match[2]!,command:match[3]??''}:null;
}
/** PID existence alone is not ownership: Windows may reuse it after a crash.
 * Failure to inspect an *alive* process remains conservative (do not steal its lock).
 */
export function lockOwnerAlive(record:unknown,purpose:'runtime'|'supervisor'):boolean{
 if(!record||typeof record!=='object')return false;
 const lock=record as LockRecord;
 if(!Number.isSafeInteger(lock.pid)||lock.pid<=0)return false;
 try{process.kill(lock.pid,0);}
 catch(error){
  if((error as NodeJS.ErrnoException).code==='ESRCH')return false;
  // EPERM and unknown errors don't prove that the process is gone.
  return true;
 }
 const actual=queryProcess(lock.pid);
 if(!actual)return true;
 if(Number.isFinite(lock.processStartedAt)){
  return Math.abs(actual.startedAt-lock.processStartedAt!)<=5000;
 }
 if(Number.isFinite(lock.startedAt)){
  // Legacy supervisor records contain lock-acquisition time, not process start.
  return actual.startedAt<=lock.startedAt!+3000 && actual.startedAt>=lock.startedAt!-60000;
 }
 // Legacy runtime records contained only PID. Reclaim obvious PID reuse when
 // it now belongs to an unrelated executable; remain conservative for Node.
 if(!/^(node|bun|deno|deskbeacon)(?:\.exe)?$/i.test(actual.name.split(/[\\/]/).pop()??''))return false;
 return /deskbeacon|__service_(?:run|supervise)/i.test(actual.command)||!actual.command.trim();
}
