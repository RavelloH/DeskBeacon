import { createServer, createConnection, type Server, type Socket } from 'node:net';
import {OutputWatchHub} from './output-watch.js';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, chmodSync, readdirSync, openSync, closeSync, readSync, statSync,
  mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ClientDaemon } from './daemon.js';
import { dataDir, loadConfig, saveConfig } from './daemon.js';
import {getConfigView,setPendingServerUrl,setProxyConfig} from './config-actions.js';
import {detectFileOutputEncoding,decodeOutputPage} from './output-encoding.js';
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
function outputPage(daemon:ClientDaemon,operationId:unknown,stream:unknown,byteOffset:unknown,maxBytes:unknown){
 const safeId=safeOperationId(operationId);
 if(stream!=='stdout'&&stream!=='stderr'&&stream!=='input')throw Error('INVALID_OUTPUT_STREAM');
 const offset=byteOffset===undefined?0:byteOffset;
 if(typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_BYTE_OFFSET');
 const budget=maxBytes===undefined?defaultOutputBytes:maxBytes;
 if(typeof budget!=='number'||!Number.isSafeInteger(budget)||budget<1||budget>maxOutputBytes)
   throw Error('INVALID_OUTPUT_BUDGET');
 const row=daemon.db?.prepare?daemon.db.prepare('SELECT record_path FROM activity WHERE id=?').get(String(operationId)) as {record_path:string|null}|undefined:undefined;
 if(row?.record_path)return daemon.journal.getRecordStream(row.record_path,stream as 'input'|'stdout'|'stderr',offset,budget);
 const root=join(dataDir,'output');
 const path=join(root,safeId+(stream==='stdout'?'.out':stream==='stderr'?'.err':'.input.json'));
 if(stream==='input'&&!existsSync(path))return {text:'',nextOffset:0,totalBytes:0,hasMore:false,stream,available:false};
 if(!existsSync(path)){
   if(offset!==0)throw Error('INVALID_BYTE_OFFSET');
   return{text:'',nextOffset:0,totalBytes:0,hasMore:false,stream};
 }
 const totalBytes=statSync(path).size;
 if(offset>totalBytes)throw Error('INVALID_BYTE_OFFSET');
 if(offset===totalBytes)return{text:'',nextOffset:offset,totalBytes,hasMore:false,stream};
 // Historical Windows programs may emit raw OEM bytes (e.g. CP936/GBK).
 // Preserve the original log on disk, decode it for IPC/TUI using byte
 // cursors and a character-boundary-aware legacy-codepage decoder.
 if(stream!=='input'){
  const encoding=detectFileOutputEncoding(path,offset);
  if(encoding!=='utf-8'){
   const length=Math.min(totalBytes-offset,budget+3);
   const bytes=Buffer.allocUnsafe(length),fd=openSync(path,'r');
   try{readSync(fd,bytes,0,length,offset);}finally{closeSync(fd);}
   const page=decodeOutputPage(bytes,budget,encoding);
   if(page.used===0&&length>0)throw Error('INVALID_OUTPUT_ENCODING_BOUNDARY');
   const nextOffset=offset+page.used;
   return{text:page.text,nextOffset,totalBytes,hasMore:nextOffset<totalBytes,stream,encoding};
  }
 }

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

/** Completed local receipts are immutable. Cache the redacted result bytes so
 * paging large files doesn't repeatedly stringify the whole receipt (O(n²)). */
const receiptBytesCache=new Map<string,Buffer>();
let receiptCachedBytes=0;
function fullResultBytes(daemon:ClientDaemon,id:string):Buffer|null{
 const previous=receiptBytesCache.get(id);
 if(previous){receiptBytesCache.delete(id);receiptBytesCache.set(id,previous);return previous;}
 const receipt=daemon.supervisor.hasReceipt(id);
 if(!receipt?.result||!['completed','failed'].includes(receipt.status))return null;
 const sensitive=/^(?:env|dataBase64)$|token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key/i;
 const raw=JSON.stringify(JSON.parse(receipt.result),(key,value)=>sensitive.test(key)?'[redacted]':value);
 const bytes=Buffer.from(raw,'utf8');
 if(bytes.length<=16*1024*1024){
  while(receiptCachedBytes+bytes.length>32*1024*1024||receiptBytesCache.size>=8){
   const oldest=receiptBytesCache.keys().next().value;
   if(oldest===undefined)break;
   const removed=receiptBytesCache.get(oldest)!;
   receiptCachedBytes-=removed.length;
   receiptBytesCache.delete(oldest);
  }
  receiptBytesCache.set(id,bytes);receiptCachedBytes+=bytes.length;
 }
 return bytes;
}
/** Full structured result is already retained in the local receipts SQLite
 * table. Read it without the activity list's bounded JSON preview. */
function resultPage(daemon:ClientDaemon,operationId:unknown,byteOffset:unknown,maxBytes:unknown){
 const safeId=safeOperationId(operationId);
 const offset=byteOffset===undefined?0:byteOffset;
 const budget=maxBytes===undefined?defaultOutputBytes:maxBytes;
 if(typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_BYTE_OFFSET');
 if(typeof budget!=='number'||!Number.isSafeInteger(budget)||budget<1||budget>maxOutputBytes)
  throw Error('INVALID_OUTPUT_BUDGET');
 const row=daemon.db?.prepare?daemon.db.prepare('SELECT record_path FROM activity WHERE id=?').get(String(operationId)) as {record_path:string|null}|undefined:undefined;
 if(row?.record_path){
  // For fs_edit, the RESULT inspector reads the actual full diff from the
  // operation journal. Legacy records without a stored diff retain JSON view.
  const diff=daemon.journal.getRecordStream(row.record_path,'diff',0,1);
  if(diff.totalBytes>0)return daemon.journal.getRecordStream(row.record_path,'diff',offset,budget);
  return daemon.journal.getRecordStream(row.record_path,'result',offset,budget);
 }
 const bytes=fullResultBytes(daemon,safeId);
 if(!bytes)return{text:'',nextOffset:0,totalBytes:0,hasMore:false,stream:'result',available:false};
 const totalBytes=bytes.length;
 if(offset>totalBytes)throw Error('INVALID_BYTE_OFFSET');
 if(offset>0&&continuationByte(bytes[offset]!))throw Error('INVALID_BYTE_OFFSET');
 let used=0;
 while(offset+used<totalBytes){
  const width=utf8CharacterBytes(bytes,offset+used,totalBytes-offset);
  if(width===0)break;
  if(used+width>budget){if(used===0)used=width;break;}
  used+=width;
 }
 const nextOffset=offset+used;
 return{text:bytes.subarray(offset,nextOffset).toString('utf8'),nextOffset,totalBytes,
  hasMore:nextOffset<totalBytes,stream:'result',available:true};
}
const ipcClients=new WeakMap<Server,Set<Socket>>();
/** Close the listener and disconnect subscriptions so the IPC drain cannot stall. */
export function closeIpc(server:Server):Promise<void>{
 const clients=ipcClients.get(server);
 return new Promise((resolve,reject)=>{
  if(!server.listening){for(const socket of clients??[])socket.destroy();resolve();return;}
  server.close(error=>error?reject(error):resolve());
  for(const socket of clients??[])socket.destroy();
 });
}
export function startIpc(daemon:ClientDaemon,onExit?:()=>Promise<void>){
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
 const outputHub=new OutputWatchHub(join(dataDir,'output'));
 const clients=new Set<Socket>();
 const server=createServer(socket=>{
   clients.add(socket);socket.once('close',()=>clients.delete(socket));
   let buffer='';
   let watchedTopics=new Set<string>();
   let subscribed=false;
   let journalIds=new Set<string>();
   const journalPending=new Map<string,{stream:'stdout'|'stderr';size:number;timer:ReturnType<typeof setTimeout>}>();
   const onJournal=(event:{taskId:string;stream:'stdout'|'stderr';size:number})=>{
     if(!journalIds.has(event.taskId))return;
     const key=event.taskId+'-'+event.stream,prior=journalPending.get(key);
     if(prior){prior.size=event.size;return;}
     const value={stream:event.stream,size:event.size,timer:setTimeout(()=>{
       journalPending.delete(key);
       if(journalIds.has(event.taskId))sendEvent({topic:'output.changed',taskId:event.taskId,stream:value.stream,size:value.size});
     },80)};
     journalPending.set(key,value);
   };
   daemon.on('journal-output',onJournal);
   let metricsTimer:ReturnType<typeof setInterval>|undefined;
   const sendEvent=(value:Record<string,unknown>)=>{
     if(socket.destroyed)return;
     // Never drop a change silently: force snapshot resync on a stalled consumer.
     if(socket.writableLength>=1024*1024){socket.destroy();return;}
     socket.write(JSON.stringify({type:'event',...value})+'\n');
   };
   const onChange=()=>{
     if(watchedTopics.has('runtime'))sendEvent({topic:'runtime.changed'});
   };
   socket.once('close',()=>{
     if(subscribed)daemon.off('change',onChange);
     if(metricsTimer)clearInterval(metricsTimer);
     outputHub.delete(socket);
     daemon.off('journal-output',onJournal);
     for(const value of journalPending.values())clearTimeout(value.timer);
     journalPending.clear();
   });
   socket.on('data',data=>{
     buffer+=data.toString('utf8');if(buffer.length>64*1024){socket.destroy();return;}
     for(let position;(position=buffer.indexOf('\n'))>=0;){
       const line=buffer.slice(0,position);buffer=buffer.slice(position+1);
       void (async()=>{
         let request:any;
         try{request=JSON.parse(line);}catch{socket.write(JSON.stringify({error:'INVALID_JSON'})+'\n');return;}
         try{
           let result:any;
           if(request.action==='watch'){
             if(!Array.isArray(request.topics)||request.topics.length>16||
               request.topics.some((topic:unknown)=>!['runtime','system.metrics'].includes(String(topic))))
               throw Error('INVALID_IPC_TOPICS');
             watchedTopics=new Set(request.topics as string[]);
             if(watchedTopics.size&&!subscribed){daemon.on('change',onChange);subscribed=true;}
             if(!watchedTopics.size&&subscribed){daemon.off('change',onChange);subscribed=false;}
             if(metricsTimer){clearInterval(metricsTimer);metricsTimer=undefined;}
             if(watchedTopics.has('system.metrics'))
               metricsTimer=setInterval(()=>sendEvent({topic:'metrics.changed'}),4000);
             result={topics:[...watchedTopics]};
           }
           else if(request.action==='output.watchSet'){
             if(!Array.isArray(request.taskIds)||request.taskIds.length>16||
               request.taskIds.some((id:unknown)=>typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)))
               throw Error('INVALID_WATCH_SET');
             journalIds=new Set(request.taskIds);
             outputHub.set(socket,request.taskIds,(change)=>sendEvent({topic:'output.changed',...change}));
             result={taskIds:request.taskIds};
           }
           else if(request.action==='subscribe'){
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
           else if(request.action==='status-lite')result=await daemon.status(false);
           else if(request.action==='status')result=await daemon.status();
           else if(request.action==='config-get')result=getConfigView();
           else if(request.action==='config-set'){
             const key=request.key,value=String(request.value??'').trim();
             if(key==='name')result={name:await daemon.rename(value)};
             else if(key==='url')result=setPendingServerUrl(value);
             else if(key==='proxy-auto'||key==='proxy-url'){result=setProxyConfig(key,value);daemon.reconnectForProxyChange();}
             else throw Error('UNKNOWN_CONFIG_KEY');
           }
           else if(request.action==='activity-list'){
             const options={cursor:request.cursor,query:request.query,limit:request.limit,watchIds:request.watchIds};
             result=request.query&&typeof daemon.activitySearch==='function'
               ?await daemon.activitySearch(options):daemon.activityList(options);
           }
           else if(request.action==='task-logs')result=daemon.supervisor.active()
             .filter(task=>task.kind==='background'&&(!Array.isArray(request.taskIds)||request.taskIds.includes(task.id)))
             .map(task=>({id:task.id,line:daemon.supervisor.latestLine(task.id)}));
           else if(request.action==='stop')result=await daemon.supervisor.stop(String(request.taskId));
           else if(request.action==='exit'){
             result={stopping:true};
             setImmediate(()=>{void (onExit?onExit():daemon.shutdown().then(()=>closeIpc(server)))
               .catch(error=>{console.error('IPC exit shutdown failed:',error);});
             });
           }
           else if(request.action==='output-tail'){
             const head=outputPage(daemon,request.operationId,request.stream,0,1);
             const start=Math.max(0,head.totalBytes-4096);
             let tail:any;
             for(let skip=0;skip<=4;skip++)try{
               tail=outputPage(daemon,request.operationId,request.stream,start+skip,8192);break;
             }catch(error){
               if(!String(error).includes('INVALID_BYTE_OFFSET')||skip===4)throw error;
             }
             result=tail;
           }
           else if(request.action==='output'||request.action==='input')result=outputPage(daemon,request.operationId,
  request.action==='input'?'input':request.stream,request.byteOffset,request.maxBytes);
           else if(request.action==='result')result=resultPage(daemon,request.operationId,request.byteOffset,request.maxBytes);
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
           socket.write(JSON.stringify(request.id===undefined?{result}:{id:request.id,result})+'\n');
         }catch(e){socket.write(JSON.stringify(request.id===undefined?{error:String(e)}:{id:request.id,error:String(e)})+'\n');}
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
 ipcClients.set(server,clients);
 server.once('close',releaseLock);
 server.once('error',releaseLock);
 server.listen(ipcPath,()=>{
   if(process.platform!=='win32')chmodSync(ipcPath,0o600);
   // Storage migrations run synchronously before Runtime and IPC startup.
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

export function subscribeIpc(onStatus:(status:any)=>void,onDisconnect:(reason?:string)=>void):()=>void{
 const socket=createConnection(ipcPath);
 let buffer='',closed=false,reason='IPC_SOCKET_CLOSED';
 socket.on('connect',()=>socket.write(JSON.stringify({action:'subscribe'})+'\n'));
 socket.on('data',data=>{
   buffer+=data.toString('utf8');
   if(buffer.length>1024*1024){socket.destroy();return;}
   for(let p;(p=buffer.indexOf('\n'))>=0;){
     const line=buffer.slice(0,p);buffer=buffer.slice(p+1);
     try{const obj=JSON.parse(line);if(obj.result)onStatus(obj.result);}catch{}
   }
 });
 socket.on('close',()=>{if(!closed)onDisconnect(reason);});
 socket.on('error',error=>{reason=(error as NodeJS.ErrnoException).code??String(error);socket.destroy();});
 return ()=>{closed=true;socket.destroy();};
}
