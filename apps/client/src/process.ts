import { execFile, spawnSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { mkdirSync, createWriteStream, existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

export type Input = Record<string,any>;
type Running = { proc: ChildProcessWithoutNullStreams; id:string; description:string; since:number; out:string; err:string; jobManaged:boolean };
const outputLimit=16*1024*1024;
const backgroundFileLimit=64*1024*1024;
const jobBinary=join(dirname(fileURLToPath(import.meta.url)),'native',process.arch==='arm64'?'win-arm64':'win-x64','deskbeacon-job.exe');
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
   return {exe,args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(c.script,'utf16le').toString('base64')],cwd};
 }
 if(shell==='cmd'||shell==='cmd.exe')return {exe:'cmd.exe',args:['/d','/s','/c',c.script],cwd};
 if(shell==='bash'||shell==='zsh'||shell==='sh')return {exe:shell,args:['-c',c.script],cwd};
 if(shell==='wsl')return{exe:'wsl.exe',args:['--exec','sh','-c',c.script],cwd};
 throw Error('UNSUPPORTED_SHELL: '+shell);
}

export class TaskSupervisor{
 private fgActive=false;
 private cancelled=new Set<string>();
 private fg=new Map<string,Running>();
 private bg=new Map<string,Running>();
 constructor(private db:DatabaseSync,private outputDir:string) {
   mkdirSync(outputDir,{recursive:true});
   db.exec("CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, status TEXT, created INTEGER, result TEXT)");
   db.exec("CREATE TABLE IF NOT EXISTS background(id TEXT PRIMARY KEY, operation_id TEXT, description TEXT, pid INTEGER, status TEXT, start INTEGER, exit_code INTEGER, stdout_path TEXT, stderr_path TEXT)");
   for(const name of ["stdout_truncated","stderr_truncated"])try{db.exec("ALTER TABLE background ADD COLUMN "+name+" INTEGER DEFAULT 0");}catch{}
 }
 hasReceipt(id:string){return this.db.prepare('SELECT status,result FROM receipts WHERE id=?').get(id) as {status:string;result:string|null}|undefined;}
 record(id:string, status:string, value:unknown) {
   this.db.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,result=excluded.result')
     .run(id,status,Date.now(),JSON.stringify(value));
 }
 async foreground(id:string,description:string,command:Input,deadlineMs=120_000){
   const began=Date.now();
   while(this.fgActive){if(Date.now()-began>10_000)throw Error('FOREGROUND_BUSY');await new Promise(r=>setTimeout(r,50));}
   this.fgActive=true;
   try{return await this.runProcess(id,description,command,Math.max(1,deadlineMs),true);}
   finally{this.fgActive=false;this.cancelled.delete(id);}
 }
 async runProcess(id:string,description:string,c:Input,timeoutMs:number,fg:boolean){
   const p=shellPlan(c);let child:ChildProcessWithoutNullStreams;
   const jobManaged=process.platform==='win32';
   if(jobManaged&&!existsSync(jobBinary))throw Error('WINDOWS_JOB_HELPER_MISSING: native win-job helper must be bundled; refusing uncontained execution: '+jobBinary);
   const exe=jobManaged?jobBinary:p.exe;
   const args=jobManaged?[Buffer.from(JSON.stringify({File:p.exe,Args:p.args,Cwd:p.cwd,ParentPid:process.pid}),'utf8').toString('base64')]:p.args;
   try{child=spawn(exe,args,{cwd:p.cwd,env:{...process.env,...c.env},windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'}) as ChildProcessWithoutNullStreams;}
   catch(e){throw Error('SPAWN_FAILED: '+String(e));}
   const safeId=id.replace(/[^a-zA-Z0-9_.-]/g,'_');
   const task:Running={proc:child,id,description,since:Date.now(),out:join(this.outputDir,safeId+'.out'),err:join(this.outputDir,safeId+'.err'),jobManaged};
   if(fg)this.fg.set(id,task);else this.bg.set(id,task);
   const outFile=createWriteStream(task.out),errFile=createWriteStream(task.err);
   let stdout='',stderr='',outputBytes=0,timedOut=false,outputLimitReached=false,spawnError='';
   let stdoutWritten=0,stderrWritten=0;
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
     const text=recorded.toString('utf8');
     if(isOut){if(stdout.length<outputLimit)stdout+=text.slice(0,outputLimit-stdout.length);if(recorded.length)outFile.write(recorded);}
     else{if(stderr.length<outputLimit)stderr+=text.slice(0,outputLimit-stderr.length);if(recorded.length)errFile.write(recorded);}
   };
   child.stdout.on('data',(c:Buffer)=>handle('stdout',c));
   child.stderr.on('data',(c:Buffer)=>handle('stderr',c));
   child.on('error',(e)=>{spawnError=String(e);});
   let timeout:NodeJS.Timeout|undefined;
   if(fg)timeout=setTimeout(()=>{timedOut=true;void stopTree(child,jobManaged);},timeoutMs);
   if(!fg){
     this.db.prepare('INSERT INTO background(id,operation_id,description,pid,status,start,stdout_path,stderr_path) VALUES(?,?,?,?,?,?,?,?)')
       .run(id,id,description,child.pid??0,'running',Date.now(),task.out,task.err);
     child.on('exit',(code)=>this.db.prepare("UPDATE background SET status='exited',exit_code=? WHERE id=?").run(code,id));
     child.on('close',()=>{outFile.end();errFile.end();this.bg.delete(id);});
     return {backgroundTaskId:id,pid:child.pid??null,description,status:'running',cwd:p.cwd,program:p.exe};
   }
   const code=await new Promise<number|null>(resolve=>child.once('close',(code)=>resolve(code)));
   if(timeout)clearTimeout(timeout);
   outFile.end();errFile.end();this.fg.delete(id);
   return {exitCode:code,stdout,stderr,timedOut,outputLimit:outputLimitReached,spawnError,
     cancelled:this.cancelled.has(id)||[...this.cancelled].some(x=>id.startsWith(x+":")),
     durationMs:Date.now()-task.since,program:p.exe,cwd:p.cwd,
     cleanup:jobManaged?'windows-job-object':'posix-process-group'};
 }
 async startBackground(id:string,description:string,c:Input){return this.runProcess(id,description,c,0,false);}
 async stop(id:string) {
   const tasks=[...this.bg.values(),...this.fg.values()].filter(t=>t.id===id||t.id.startsWith(id+":"));
   if(tasks.length===0)return {stopped:false,reason:'not-running'};
   this.cancelled.add(id);
   await Promise.all(tasks.map(async task=>stopTree(task.proc,task.jobManaged)));
   return {stopped:true,taskId:id,processesSignalled:tasks.length};
 }
 list(){
   return this.db.prepare('SELECT id,description,pid,status,start,exit_code FROM background ORDER BY start DESC LIMIT 200').all();
 }
 get(id:string){return this.db.prepare('SELECT * FROM background WHERE id=?').get(id)??null;}
 output(id:string,stream:string,offset:number,maxBytes:number,maxLines=5000){
   const row=this.get(id) as any;if(!row)throw Error('BACKGROUND_NOT_FOUND');
   if(!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_CURSOR');
   const paths=stream==='stderr'?[row.stderr_path]:stream==='stdout'?[row.stdout_path]:[row.stdout_path,row.stderr_path];
   const results=paths.map((p:string)=>{
     if(!existsSync(p))return{path:p,text:'',total:0,nextOffset:0,hasMore:false};
     const st=statSync(p),start=Math.min(offset,st.size),length=Math.min(maxBytes,st.size-start);
     const buf=Buffer.alloc(length),fd=openSync(p,'r');
     try{readSync(fd,buf,0,length,start);}finally{closeSync(fd);}
     const text=buf.toString('utf8');
     const selected=text.split(/(?<=\n)/).slice(0,maxLines).join('');
     const used=Buffer.byteLength(selected);
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
