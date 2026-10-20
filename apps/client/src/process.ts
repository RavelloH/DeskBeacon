import { execFile, spawnSync } from 'node:child_process';
import {decodeOutputText,detectFileOutputEncoding,decodeOutputPage} from './output-encoding.js';
import spawn from 'cross-spawn';
import {normalizeProcessStderr,errorSummary} from './terminal-errors.js';
import { mkdirSync, createWriteStream, existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { platform, tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type {RecordJournal} from './record-journal.js';
import { ForegroundPool } from './foreground-pool.js';
import { LIMITS } from '@deskbeacon/protocol';

export type Input = Record<string,any>;
type Running = { proc: ChildProcessWithoutNullStreams; id:string; description:string; since:number; out:string; err:string; jobManaged:boolean };
const outputLimit=16*1024*1024;
const backgroundFileLimit=64*1024*1024;
const resolveNativeRequire=createRequire(import.meta.url);
export function resolveWindowsJobBinary(platform=process.platform,arch=process.arch):string{
 if(platform!=='win32')throw Error('WINDOWS_JOB_HELPER_MISSING: Win32 Job Object helper is Windows-only');
 const name=arch==='x64'?'@deskbeacon/win32-x64':arch==='arm64'?'@deskbeacon/win32-arm64':null;
 if(!name)throw Error('WINDOWS_JOB_HELPER_MISSING: Unsupported Windows architecture '+arch);
 // Tests may use a separate, freshly compiled helper without touching the running Service.
 if(process.env.DESKBEACON_JOB_BINARY){
  if(existsSync(process.env.DESKBEACON_JOB_BINARY))return process.env.DESKBEACON_JOB_BINARY;
  throw Error('WINDOWS_JOB_HELPER_MISSING: Native executable not found at '+process.env.DESKBEACON_JOB_BINARY);
 }
 try{
  const exe=resolveNativeRequire.resolve(name+'/deskbeacon-job.exe');
  if(existsSync(exe))return exe;
 }catch{}
 throw Error('WINDOWS_JOB_HELPER_MISSING: Install the optional native package '+name+
  ' (check npm install --omit=optional and architecture); refusing uncontained execution');
}
function stopTree(proc:ChildProcessWithoutNullStreams,jobManaged=false):Promise<void>{
  return new Promise(resolve=>{
    if(!proc.pid) return resolve();
    if(process.platform==='win32'&&jobManaged){
      // Windows kernel kills all descendants when the launcher Job handle closes.
      // No process-tree enumeration race and no taskkill dependency.
      try{proc.kill('SIGKILL');}catch{}
      resolve();
    }else if(process.platform==='win32'){
      execFile('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true},()=>resolve());
    } else {
      try{process.kill(-proc.pid,'SIGKILL');}catch{try{proc.kill('SIGKILL');}catch{}}
      resolve();
    }
  });
}
function shellPlan(c:Input):{exe:string;args:string[];cwd:string}{
 const cwd=c.cwd??process.cwd();
 if(c.mode==='program')return {exe:c.program,args:c.args??[],cwd};
 const shell=c.shellProfile??(process.platform==='win32'?(spawnSync('where.exe',['pwsh.exe'],{windowsHide:true}).status===0?'pwsh':'powershell'):process.platform==='darwin'?'zsh':'bash');
 if(shell==='powershell'||shell==='pwsh'||shell==='powershell.exe'||shell==='pwsh.exe'){
   const exe=shell.startsWith('pwsh')?'pwsh.exe':'powershell.exe';
   // Initialize UTF-8 for pipe-backed PowerShell, including Windows PowerShell 5.1.
   // A nested script block preserves leading param() and using directives.
   const bootstrap = '$ProgressPreference = "SilentlyContinue"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false);';
   const script = `${bootstrap}\n& {\n${c.script}\n}`;
   return {exe,args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],cwd};
 }
 if(shell==='cmd'||shell==='cmd.exe')return {exe:'cmd.exe',args:['/d','/s','/c',c.script],cwd};
 if(shell==='bash'||shell==='zsh'||shell==='sh')return {exe:shell,args:['-c',c.script],cwd};
 if(shell==='wsl')return{exe:'wsl.exe',args:['--exec','sh','-c',c.script],cwd};
 throw Error('UNSUPPORTED_SHELL: '+shell);
}

export class TaskSupervisor{
 readonly foregroundPool=new ForegroundPool(LIMITS.foregroundConcurrency,32);
 private cancelled=new Set<string>();
 private batches=new Set<string>();
 private fg=new Map<string,Running>();
 private bg=new Map<string,Running>();
 constructor(private db:DatabaseSync,private outputDir:string,private onChange:()=>void=()=>{},private journal?:RecordJournal) {
   if(!this.journal)mkdirSync(outputDir,{recursive:true});
   db.exec("CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, status TEXT, created INTEGER, result TEXT)");
   db.exec("CREATE TABLE IF NOT EXISTS background(id TEXT PRIMARY KEY, operation_id TEXT, description TEXT, pid INTEGER, status TEXT, start INTEGER, exit_code INTEGER, stdout_path TEXT, stderr_path TEXT)");
   try{db.exec('ALTER TABLE background ADD COLUMN record_path TEXT');}catch{}
   for(const name of ["stdout_truncated","stderr_truncated"])try{db.exec("ALTER TABLE background ADD COLUMN "+name+" INTEGER DEFAULT 0");}catch{}
 }
 hasReceipt(id:string){return this.db.prepare('SELECT status,result FROM receipts WHERE id=?').get(id) as {status:string;result:string|null}|undefined;}
 record(id:string, status:string, value:unknown) {
   this.db.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,result=excluded.result')
     .run(id,status,Date.now(),this.journal?null:JSON.stringify(value));
 }
 async foreground(id:string,description:string,command:Input,deadlineMs=120_000,onStart?:()=>void){
   return this.foregroundPool.run(id,()=>{
     if(this.isCancelled(id))throw Error('CANCELLED: Foreground operation cancelled');
     return this.runProcess(id,description,command,Math.max(1,deadlineMs),true);
   },onStart);
 }
 isCancelled(id:string){return [...this.cancelled].some(x=>id===x||id.startsWith(x+':'));}
 clearCancelled(id:string){this.cancelled.delete(id);}
 trackBatch(id:string,active:boolean){if(active)this.batches.add(id);else{this.batches.delete(id);this.clearCancelled(id);}}

 async runProcess(id:string,description:string,c:Input,timeoutMs:number,fg:boolean){
   const p=shellPlan(c);let child:ChildProcessWithoutNullStreams;
   const jobManaged=process.platform==='win32';
   const exe=jobManaged?resolveWindowsJobBinary():p.exe;
   const args=jobManaged?[Buffer.from(JSON.stringify({File:p.exe,Args:p.args,Cwd:p.cwd,ParentPid:process.pid}),'utf8').toString('base64')]:p.args;
   try{child=spawn(exe,args,{cwd:p.cwd,env:{...process.env,...c.env},windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'}) as ChildProcessWithoutNullStreams;}
   catch(e){throw Error('SPAWN_FAILED: '+String(e));}
   const safeId=id.replace(/[^a-zA-Z0-9_.-]/g,'_');
   const task:Running={proc:child,id,description,since:Date.now(),out:join(this.outputDir,safeId+'.out'),err:join(this.outputDir,safeId+'.err'),jobManaged};
   if(fg)this.fg.set(id,task);else this.bg.set(id,task);
   const journaled=Boolean(this.journal?.getOpenPath(id));
   if(!journaled)mkdirSync(this.outputDir,{recursive:true});
   const outFile=journaled?null:createWriteStream(task.out),errFile=journaled?null:createWriteStream(task.err);
   let stdout='',stderr='',outputBytes=0,timedOut=false,outputLimitReached=false,spawnError='';
   let stdoutWritten=0,stderrWritten=0;
   // Keep original bytes on disk. Decode once per completed foreground stream
   // so OEM multibyte characters split between data events remain intact.
   const chunks:{stdout:Buffer[];stderr:Buffer[]}={stdout:[],stderr:[]};
   const handle=(stream:'stdout'|'stderr',data:Buffer)=>{
     const prior=outputBytes;outputBytes+=data.byteLength;
     if(outputBytes>outputLimit&&fg&&!outputLimitReached){outputLimitReached=true;void stopTree(child,jobManaged);}
     const isOut=stream==='stdout';
     const limit=fg?Math.max(0,outputLimit-prior):Math.max(0,backgroundFileLimit-(isOut?stdoutWritten:stderrWritten));
     const recorded=data.subarray(0,Math.min(data.byteLength,limit));
     if(!fg){
       if(isOut)stdoutWritten+=recorded.byteLength;else stderrWritten+=recorded.byteLength;
       if(recorded.byteLength<data.byteLength){
         this.db.prepare('UPDATE background SET '+(isOut?'stdout_truncated':'stderr_truncated')+'=1 WHERE id=?').run(id);
       }
     }
     if(fg&&recorded.length)chunks[stream].push(recorded);
     if(recorded.length&&journaled){
       try{this.journal!.stream(id,stream,recorded);}catch(e){
         spawnError='RECORD_WRITE_FAILED: '+String(e);
         void stopTree(child,jobManaged);
       }
     }
     else if(isOut){if(recorded.length)outFile?.write(recorded);}
     else{if(recorded.length)errFile?.write(recorded);}
   };
   child.stdout.on('data',(c:Buffer)=>handle('stdout',c));
   child.stderr.on('data',(c:Buffer)=>handle('stderr',c));
   child.on('error',(e)=>{spawnError=String(e);});
   let timeout:NodeJS.Timeout|undefined;
   if(fg)timeout=setTimeout(()=>{timedOut=true;void stopTree(child,jobManaged);},timeoutMs);
   if(!fg){
     // spawn() reports ENOENT/EACCES asynchronously. Do not acknowledge a
     // phantom "running" task with pid 0 before the spawn event succeeds.
     const failure=await new Promise<Error|null>(resolve=>{
       child.once('spawn',()=>resolve(null));
       child.once('error',error=>resolve(error));
     });
     if(failure){
       this.bg.delete(id);
       outFile?.end();errFile?.end();this.onChange();
       throw Error('SPAWN_FAILED: '+String(failure));
     }
     this.db.prepare('INSERT INTO background(id,operation_id,description,pid,status,start,stdout_path,stderr_path,record_path) VALUES(?,?,?,?,?,?,?,?,?)')
       .run(id,id,description,child.pid??0,'running',Date.now(),journaled?null:task.out,journaled?null:task.err,journaled?this.journal?.getOpenPath(id)??null:null);
     // Unlike 'exit', 'close' is also emitted after a failed spawn.
     child.on('close',(code)=>{
       this.db.prepare("UPDATE background SET status='exited',exit_code=? WHERE id=?").run(code,id);
       outFile?.end();errFile?.end();this.journal?.processExit(id,code);this.bg.delete(id);this.onChange();
     });
     return {backgroundTaskId:id,pid:child.pid??null,description,status:'running',cwd:p.cwd,program:p.exe};
   }
   const code=await new Promise<number|null>(resolve=>child.once('close',(code)=>resolve(code)));
   stdout=decodeOutputText(Buffer.concat(chunks.stdout));
   stderr=decodeOutputText(Buffer.concat(chunks.stderr));
   if(timeout)clearTimeout(timeout);
   outFile?.end();errFile?.end();this.fg.delete(id);this.onChange();
   const readableStderr=normalizeProcessStderr(stderr);
   return {exitCode:code,stdout,stderr:readableStderr,
     ...(code!==0&&readableStderr?{errorSummary:errorSummary(readableStderr,code)}:{}),
     timedOut,outputLimit:outputLimitReached,spawnError,
     cancelled:this.cancelled.has(id)||[...this.cancelled].some(x=>id.startsWith(x+":")),
     durationMs:Date.now()-task.since,program:p.exe,cwd:p.cwd,
     cleanup:jobManaged?'windows-job-object':'posix-process-group'};
 }
 async startBackground(id:string,description:string,c:Input){return this.runProcess(id,description,c,0,false);}
 async stop(id:string) {
   const tasks=[...this.bg.values(),...this.fg.values()].filter(t=>t.id===id||t.id.startsWith(id+":"));
   const queued=this.foregroundPool.cancelPending(id);
   if(tasks.length===0&&queued===0&&!this.batches.has(id))return {stopped:false,reason:'not-running'};
   this.cancelled.add(id);
   await Promise.all(tasks.map(async task=>stopTree(task.proc,task.jobManaged)));
   return {stopped:true,taskId:id,processesSignalled:tasks.length,queuedCancelled:queued};
 }
 list(){
   return this.db.prepare('SELECT id,description,pid,status,start,exit_code FROM background ORDER BY start DESC LIMIT 200').all();
 }
 latestLine(id:string){
   const task=this.bg.get(id);if(!task)return '';
   const ref=this.journal?.getOpenPath(id);
   if(ref){try{const parts=[this.journal!.getTail(ref,'stdout',8192).text,this.journal!.getTail(ref,'stderr',8192).text];return parts.flatMap(s=>s.split(/\r?\n/)).filter(s=>s.trim()).at(-1)??'';}catch{return '';}}
   let latest={mtime:-1,line:''};
   for(const path of [task.out,task.err])try{
     if(!existsSync(path))continue;
     const info=statSync(path),length=Math.min(info.size,8192);
     if(!length)continue;
     const buffer=Buffer.alloc(length),fd=openSync(path,'r');
     try{readSync(fd,buffer,0,length,info.size-length);}finally{closeSync(fd);}
     const encoding=detectFileOutputEncoding(path,Math.max(0,info.size-length));
     const lines=new TextDecoder(encoding).decode(buffer).replace(/\r\n?/g,'\n')
       .split('\n').filter(line=>line.trim().length>0);
     const line=lines[lines.length-1]??'';
     if(line&&info.mtimeMs>=latest.mtime)latest={mtime:info.mtimeMs,line};
   }catch{}
   return latest.line;
 }
 get(id:string){return this.db.prepare('SELECT * FROM background WHERE id=?').get(id)??null;}
 output(id:string,stream:string,offset:number,maxBytes:number,maxLines=5000){
   const row=this.get(id) as any;if(!row)throw Error('BACKGROUND_NOT_FOUND');
   if(row.record_path&&this.journal){
    const streams=stream==='both'?['stdout','stderr']:[stream];
    return {results:streams.map(s=>{const p=this.journal!.getRecordStream(row.record_path,s as 'stdout'|'stderr',offset,maxBytes);return{path:row.record_path,text:p.text,total:p.totalBytes,nextOffset:p.nextOffset,hasMore:p.hasMore,truncated:s==='stdout'?Boolean(row.stdout_truncated):Boolean(row.stderr_truncated)};})};
   }
   if(!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_CURSOR');
   const paths=stream==='stderr'?[row.stderr_path]:stream==='stdout'?[row.stdout_path]:[row.stdout_path,row.stderr_path];
   const results=paths.map((p:string)=>{
     if(!existsSync(p))return{path:p,text:'',total:0,nextOffset:0,hasMore:false};
     const st=statSync(p),start=Math.min(offset,st.size),length=Math.min(maxBytes+3,st.size-start);
     const buf=Buffer.alloc(length),fd=openSync(p,'r');
     try{readSync(fd,buf,0,length,start);}finally{closeSync(fd);}
     const encoding=detectFileOutputEncoding(p,start);
     const page=decodeOutputPage(buf,Math.min(maxBytes,st.size-start),encoding);
     let used=page.used;
     if(maxLines<5000){
       let lines=0;
       for(let i=0;i<used;i++)if(buf[i]===10&&++lines===maxLines){used=i+1;break;}
     }
     const selected=new TextDecoder(encoding).decode(buf.subarray(0,used));
     return{path:p,text:selected,total:st.size,nextOffset:start+used,hasMore:start+used<st.size,
       truncated:p===row.stdout_path?Boolean(row.stdout_truncated):Boolean(row.stderr_truncated)};
   });
   return{results};
 }
 input(id:string,data:string,signal:string) {
   const task=this.bg.get(id);if(!task)throw Error('BACKGROUND_NOT_RUNNING');
   if(signal==='ctrl_c')task.proc.stdin.write('\x03');else if(signal==='eof')task.proc.stdin.end();
   else task.proc.stdin.write(data);
   return {written:true};
 }
 active(){return [...this.fg.values(),...this.bg.values()].map(x=>({id:x.id,description:x.description,pid:x.proc.pid,start:x.since,kind:this.bg.has(x.id)?'background':'foreground'}));}
}
