import { createServer, createConnection } from 'node:net';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, chmodSync, readdirSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import type { ClientDaemon } from './daemon.js';
import { dataDir } from './daemon.js';
export const ipcPath=process.env.DESKBEACON_IPC_PATH ?? (platform()==='win32'?'\\\\.\\pipe\\deskbeacon-'+process.env.USERNAME:
  join(dataDir,'daemon.sock'));

export function startIpc(daemon:ClientDaemon){
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
           if(request.action==='status')result=daemon.status();
           else if(request.action==='stop')result=await daemon.supervisor.stop(String(request.taskId));
           else if(request.action==='exit') {result={stopping:true};setImmediate(()=>{daemon.stop();server.close();process.exit(0);});}
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
 server.listen(ipcPath,()=>{
   if(process.platform!=='win32')chmodSync(ipcPath,0o600);
   console.log('(( · )) DeskBeacon daemon listening locally');
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
       clearTimeout(timer);socket.end();
       try{const obj=JSON.parse(buffer.slice(0,end));if(obj.error)reject(Error(obj.error));else resolve(obj.result);}
       catch(e){reject(e);}
     }
   });
   socket.once('error',e=>{clearTimeout(timer);reject(e);});
 });
}
