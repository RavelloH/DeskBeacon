import { createServer, createConnection } from 'node:net';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, chmodSync, readdirSync, openSync, closeSync, readSync, statSync,
  mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ClientDaemon } from './daemon.js';
import { dataDir } from './daemon.js';
export const ipcPath=process.env.DESKBEACON_IPC_PATH ?? (platform()==='win32'?'\\\\.\\pipe\\deskbeacon-'+process.env.USERNAME:
  join(dataDir,'daemon.sock'));

const defaultOutputBytes=16*1024;
const maxOutputBytes=64*1024;
const continuationByte=(byte:number)=>byte>=0x80&&byte<=0xbf;
function utf8CharacterBytes(bytes:Buffer,offset:number,totalBytes:number):number{
 const first=bytes[offset]!;
 let length=first>=0xc2&&first<=0xdf?2:first>=0xe0&&first<=0xef?3:first>=0xf0&&first<=0xf4?4:1;
 if(length===1)return 1;
 if(offset+length>bytes.length){
   // An incomplete sequence at actual EOF is malformed text, so consume it as
   // replacement text. Otherwise leave it for the next page.
   return totalBytes<=bytes.length?1:0;
 }
 for(let i=1;i<length;i++)if(!continuationByte(bytes[offset+i]!))return 1;
 const second=bytes[offset+1]!;
 if((first===0xe0&&second<0xa0)||(first===0xed&&second>=0xa0)||
    (first===0xf0&&second<0x90)||(first===0xf4&&second>=0x90))return 1;
 return length;
}
function safeOperationId(value:unknown):string{
 if(typeof value!=='string'||value.length<1||value.length>128||! /^[a-zA-Z0-9_.:-]+$/.test(value)||value==='.'||value==='..')
   throw Error('INVALID_OPERATION_ID');
 return value.replace(/[^a-zA-Z0-9_.-]/g,'_');
}
function outputPage(operationId:unknown,stream:unknown,byteOffset:unknown,maxBytes:unknown){
 const safeId=safeOperationId(operationId);
 if(stream!=='stdout'&&stream!=='stderr')throw Error('INVALID_OUTPUT_STREAM');
 const offset=byteOffset===undefined?0:byteOffset;
 if(typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_BYTE_OFFSET');
 const budget=maxBytes===undefined?defaultOutputBytes:maxBytes;
 if(typeof budget!=='number'||!Number.isSafeInteger(budget)||budget<1||budget>maxOutputBytes)
   throw Error('INVALID_OUTPUT_BUDGET');
 const root=join(dataDir,'output');
 const path=join(root,safeId+(stream==='stdout'?'.out':'.err'));
 if(!existsSync(path)){
   if(offset!==0)throw Error('INVALID_BYTE_OFFSET');
   return{text:'',nextOffset:0,totalBytes:0,hasMore:false,stream};
 }
 const totalBytes=statSync(path).size;
 if(offset>totalBytes)throw Error('INVALID_BYTE_OFFSET');
 if(offset===totalBytes)return{text:'',nextOffset:offset,totalBytes,hasMore:false,stream};

 // A caller-supplied cursor must point between UTF-8 code points. Cursors
 // returned below always do; reject hand-crafted offsets into a multibyte
 // character instead of returning mojibake or silently dropping its tail.
 if(offset>0){
   const lookbackStart=Math.max(0,offset-3),lookbackLength=Math.min(totalBytes-lookbackStart,offset-lookbackStart+3);
   const lookback=Buffer.alloc(lookbackLength),fd=openSync(path,'r');
   try{readSync(fd,lookback,0,lookbackLength,lookbackStart);}finally{closeSync(fd);}
   const boundary=offset-lookbackStart;
   for(let i=Math.max(0,boundary-3);i<boundary;i++){
     const width=utf8CharacterBytes(lookback,i,lookback.length);
     if(width>1&&i+width>boundary&&i+width<=lookback.length)throw Error('INVALID_BYTE_OFFSET');
   }
 }

 const readLength=Math.min(totalBytes-offset,budget+3);
 const bytes=Buffer.alloc(readLength),fd=openSync(path,'r');
 try{readSync(fd,bytes,0,readLength,offset);}finally{closeSync(fd);}
 let used=0;
 while(used<bytes.length){
   const width=utf8CharacterBytes(bytes,used,totalBytes-offset);
   if(width===0)break;
   if(used+width>budget){
     // A budget smaller than one UTF-8 character still makes progress by
     // returning that character intact (at most four bytes).
     if(used===0)used=width;
     break;
   }
   used+=width;
 }
 const nextOffset=offset+used;
 return{text:bytes.subarray(0,used).toString('utf8'),nextOffset,totalBytes,hasMore:nextOffset<totalBytes,stream};
}

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
             let statusReadPending=false,statusDirty=false;
             const notify=()=>{
               if(socket.destroyed)return;
               if(statusReadPending){statusDirty=true;return;}
               statusReadPending=true;
               void daemon.status().then(status=>{
                 if(!socket.destroyed)socket.write(JSON.stringify({result:status})+'\n');
               }).catch(()=>{}).finally(()=>{
                 statusReadPending=false;
                 if(statusDirty){statusDirty=false;notify();}
               });
             };
             daemon.on('change',notify);
             socket.once('close',()=>daemon.off('change',notify));
             notify();
             return;
           }
           if(request.action==='status')result=await daemon.status();
           else if(request.action==='activity-list')result=daemon.activityList({
             cursor:request.cursor,query:request.query,limit:request.limit,watchIds:request.watchIds
           });
           else if(request.action==='task-logs')result=daemon.supervisor.active()
             .filter(task=>task.kind==='background')
             .map(task=>({id:task.id,line:daemon.supervisor.latestLine(task.id)}));
           else if(request.action==='stop')result=await daemon.supervisor.stop(String(request.taskId));
           else if(request.action==='exit') {result={stopping:true};setImmediate(()=>{void daemon.shutdown().finally(()=>server.close());});}
           else if(request.action==='output')result=outputPage(request.operationId,request.stream,request.byteOffset,request.maxBytes);
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
