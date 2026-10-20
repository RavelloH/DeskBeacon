import {createConnection,type Socket} from 'node:net';
import {ipcPath} from './ipc.js';

export type LiveEvent={topic:string;taskId?:string;stream?:'stdout'|'stderr';size?:number};
export class LiveIpcClient{
 private socket:Socket;
 private pending=new Map<number,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private nextId=0;
 private buffer='';
 private closed=false;
 private constructor(socket:Socket,private readonly onEvent:(event:LiveEvent)=>void,private readonly onDisconnect:(reason:string)=>void){
  this.socket=socket;
  socket.on('data',chunk=>{
   this.buffer+=chunk.toString('utf8');
   if(this.buffer.length>16*1024*1024){socket.destroy(Error('IPC_FRAME_TOO_LARGE'));return;}
   for(let pos;(pos=this.buffer.indexOf('\n'))>=0;){
    const line=this.buffer.slice(0,pos);this.buffer=this.buffer.slice(pos+1);
    try{
     const msg=JSON.parse(line);
     if(msg.type==='event'){this.onEvent(msg);continue;}
     const current=this.pending.get(msg.id);
     if(!current)continue;
     this.pending.delete(msg.id);clearTimeout(current.timer);
     if(msg.error)current.reject(Error(String(msg.error)));
     else current.resolve(msg.result);
    }catch{/* malformed frame must not crash the TUI */}
   }
  });
  socket.on('close',()=>this.disconnect('IPC_SOCKET_CLOSED'));
  socket.on('error',error=>this.disconnect(String(error)));
 }
 static connect(onEvent:(event:LiveEvent)=>void,onDisconnect:(reason:string)=>void,timeoutMs=2500){
  return new Promise<LiveIpcClient>((resolve,reject)=>{
   const socket=createConnection(ipcPath);
   const timer=setTimeout(()=>{socket.destroy();reject(Error('DAEMON_IPC_TIMEOUT'));},timeoutMs);
   socket.once('connect',()=>{clearTimeout(timer);resolve(new LiveIpcClient(socket,onEvent,onDisconnect));});
   socket.once('error',error=>{clearTimeout(timer);reject(error);});
  });
 }
 request<T=any>(body:Record<string,unknown>,timeoutMs=2500):Promise<T>{
  if(this.closed)return Promise.reject(Error('IPC_DISCONNECTED'));
  const id=++this.nextId;
  return new Promise<T>((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('DAEMON_IPC_TIMEOUT'));},timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   this.socket.write(JSON.stringify({...body,id})+'\n',error=>{
    if(!error)return;
    const pending=this.pending.get(id);if(!pending)return;
    this.pending.delete(id);clearTimeout(pending.timer);reject(error);
   });
  });
 }
 close(){this.closed=true;this.socket.destroy();this.rejectAll();}
 private rejectAll(){
  for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('IPC_DISCONNECTED'));}
  this.pending.clear();
 }
 private disconnect(reason:string){
  if(this.closed)return;
  this.closed=true;this.rejectAll();this.onDisconnect(reason);
 }
}
