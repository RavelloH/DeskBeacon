import { createServer, createConnection } from 'node:net';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, chmodSync, readdirSync, openSync, closeSync, readSync, statSync,
  mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ClientDaemon } from './daemon.js';
import { dataDir } from './daemon.js';
export const ipcPath=process.env.DESKBEACON_IPC_PATH ?? (platform()==='win32'?'\\\\.\\pipe\\deskbeacon-'+process.env.USERNAME:
  join(dataDir,'daemon.sock'));

export function startIpc(daemon:ClientDaemon){
 // Exclusive atomic lock prevents two TUI windows from opening separate device
 // connections, including on Unix where deleting an active socket is unsafe.
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 const lockPath=join(dataDir,'runtime.lock');
 let owned=false;
 for(let attempt=0;attempt<3&&!owned;attempt++){
   try{
     const fd=openSync(lockPath,'wx',0o600);
     try{writeFileSync(fd,JSON.stringify({pid:process.pid}));}finally{closeSync(fd);}
     owned=true;
   }catch(e){
     const error=e as NodeJS.ErrnoException;
     if(error.code!=='EEXIST')throw e;
     try{
       const pid=Number(JSON.parse(readFileSync(lockPath,'utf8')).pid);
       if(pid>0){
         try{process.kill(pid,0);throw Error('RUNTIME_ALREADY_RUNNING: PID '+pid);}catch(ex){
           if((ex as NodeJS.ErrnoException).code!=='ESRCH')throw ex;
         }
       }
       rmSync(lockPath,{force:true});
     }catch(ex){
       if((ex as Error).message.startsWith('RUNTIME_ALREADY_RUNNING'))throw ex;
       if((ex as NodeJS.ErrnoException).code==='EPERM')throw ex;
       rmSync(lockPath,{force:true});
     }
   }
 }
 if(!owned)throw Error('RUNTIME_LOCK_UNAVAILABLE');
 if(process.platform!=='win32'&&existsSync(ipcPath))rmSync(ipcPath,{force:true});
 const server=createServer(socket=>{
   let buffer='';
   socket.on('data',data=>{
     buffer+=data.toString('utf8');if(buffer.length>64*1024){socket.destroy();return;}
     for(let position;(position=buffer.indexOf('\n'))>=0;){
       const line=buffer.slice(0,position);buffer=buffer.slice(position+1);
       void (async()=>{
         let request:any;
         try{request=JSON.parse(line);}catch{socket.write(JSON.stringify({error:'INVALID_JSON'})+'\n');return;}
         try{
           let result:any;
           if(request.action==='subscribe'){
             const notify=()=>{
               if(socket.destroyed)return;
               try{socket.write(JSON.stringify({result:daemon.status()})+'\n');}catch{}
             };
             daemon.on('change',notify);
             socket.once('close',()=>daemon.off('change',notify));
             notify();
             return;
           }
           if(request.action==='status')result=daemon.status();
           else if(request.action==='stop')result=await daemon.supervisor.stop(String(request.taskId));
           else if(request.action==='exit') {result={stopping:true};setImmediate(()=>{void daemon.shutdown().finally(()=>server.close());});}
           else if(request.action==='logs') {
             const row=daemon.db.prepare('SELECT * FROM activity WHERE id=?').get(String(request.operationId));
             const id=String(request.operationId);
             const root=join(dataDir,'output'),files=existsSync(root)?readdirSync(root):[];
             const paths=files.filter(file=>file.startsWith(id.replace(/[^a-zA-Z0-9_.-]/g,'_'))&&/\.(out|err)$/.test(file)).slice(0,64);
             result={activity:row,outputs:paths.map(file=>{
               const p=join(root,file),st=statSync(p),len=Math.min(st.size,16384),buf=Buffer.alloc(len);
               const handle=openSync(p,'r');try{readSync(handle,buf,0,len,st.size-len);}finally{closeSync(handle);}
               return{filename:file,text:buf.toString('utf8')};
             })};
           }
           else result={error:'UNKNOWN_LOCAL_COMMAND'};
           socket.write(JSON.stringify({result})+'\n');
         }catch(e){socket.write(JSON.stringify({error:String(e)})+'\n');}
       })();
     }
   });
 });
 const releaseLock=()=>{
   try{
     const current=JSON.parse(readFileSync(lockPath,'utf8')) as {pid:number};
     if(current.pid===process.pid)rmSync(lockPath,{force:true});
   }catch{}
   if(process.platform!=='win32')try{rmSync(ipcPath,{force:true});}catch{}
 };
 server.once('close',releaseLock);
 server.once('error',releaseLock);
 server.listen(ipcPath,()=>{
   if(process.platform!=='win32')chmodSync(ipcPath,0o600);
   // IPC is shared by the foreground TUI and explicit background service.
 });
 return server;
}
export function requestIpc(request:object,timeoutMs=2500):Promise<any>{
 return new Promise((resolve,reject)=>{
   const socket=createConnection(ipcPath);let buffer='';
   const timer=setTimeout(()=>{socket.destroy();reject(Error('DAEMON_IPC_TIMEOUT'));},timeoutMs);
   socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
   socket.on('data',data=>{
     buffer+=data.toString('utf8');
     const end=buffer.indexOf('\n');
     if(end>=0){
       clearTimeout(timer);socket.destroy();
       try{const obj=JSON.parse(buffer.slice(0,end));if(obj.error)reject(Error(obj.error));else resolve(obj.result);}
       catch(e){reject(e);}
     }
   });
   socket.once('error',e=>{clearTimeout(timer);reject(e);});
 });
}

export function subscribeIpc(onStatus:(status:any)=>void,onDisconnect:()=>void):()=>void{
 const socket=createConnection(ipcPath);
 let buffer='',closed=false;
 socket.on('connect',()=>socket.write(JSON.stringify({action:'subscribe'})+'\n'));
 socket.on('data',data=>{
   buffer+=data.toString('utf8');
   if(buffer.length>1024*1024){socket.destroy();return;}
   for(let p;(p=buffer.indexOf('\n'))>=0;){
     const line=buffer.slice(0,p);buffer=buffer.slice(p+1);
     try{const obj=JSON.parse(line);if(obj.result)onStatus(obj.result);}catch{}
   }
 });
 socket.on('close',()=>{if(!closed)onDisconnect();});
 socket.on('error',()=>{socket.destroy();});
 return ()=>{closed=true;socket.destroy();};
}
