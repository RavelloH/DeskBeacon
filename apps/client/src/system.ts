import si from 'systeminformation';
import { lookup, resolve as resolveDns } from 'node:dns/promises';
import { connect as tcpConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import screen from 'screenshot-desktop';
import sharp from 'sharp';
type I=Record<string,any>;
const limited=(s:string,max:number)=>s.length>max?s.slice(0,max):s;
export async function systemTool(name:string,i:I){
 switch(name){
 case 'system_snapshot':{
   const [cpu,load,mem,disks,network]=await Promise.all([
     si.cpu(),si.currentLoad(),si.mem(),
     i.includeDisks===false?Promise.resolve([]):si.fsSize(),
     i.includeNetwork===false?Promise.resolve([]):si.networkInterfaces()]);
   return {timestamp:new Date().toISOString(),platform:process.platform,architecture:process.arch,
     cpu:{model:cpu.brand,cores:cpu.cores,loadPercent:load.currentLoad},
     memory:{totalBytes:mem.total,availableBytes:mem.available,usedBytes:mem.used},
     disks:(disks as any[]).map(x=>({mount:x.mount,totalBytes:x.size,usedBytes:x.used,usedPercent:x.use})),
     network:(network as any[]).map(x=>({name:x.iface,ip4:x.ip4,ip6:x.ip6,internal:x.internal}))};
 }
 case 'system_processes':{
   const all=await si.processes();let rows=all.list as any[];
   if(i.pid)rows=rows.filter(p=>p.pid===i.pid);
   if(i.name)rows=rows.filter(p=>String(p.name).toLowerCase().includes(String(i.name).toLowerCase()));
   rows.sort((a,b)=>i.sortBy==='name'?String(a.name).localeCompare(String(b.name)):
     i.sortBy==='pid'?a.pid-b.pid:(b[i.sortBy??'cpu']??0)-(a[i.sortBy??'cpu']??0));
   return {processes:rows.slice(0,i.limit??200).map(p=>({pid:p.pid,parentPid:p.parentPid,name:p.name,
     cpuPercent:p.cpu,memoryBytes:p.memRss,started:p.started,user:p.user})),
     totalMatches:rows.length,truncated:rows.length>(i.limit??200)};
 }
 case 'net_ports':{
   const all=await si.networkConnections();
   let rows=all as any[];
   if(i.protocol&&i.protocol!=='all')rows=rows.filter(r=>String(r.protocol).toLowerCase().includes(i.protocol));
   if(i.state&&i.state!=='all')rows=rows.filter(r=>i.state==='listen'?/listen/i.test(r.state):/established/i.test(r.state));
   if(i.port)rows=rows.filter(r=>r.localPort===String(i.port)||r.localPort===i.port);
   if(i.pid)rows=rows.filter(r=>r.pid===i.pid);
   if(i.address)rows=rows.filter(r=>String(r.localAddress).includes(i.address));
   return{connections:rows.slice(0,i.limit??200).map(r=>({protocol:r.protocol,state:r.state,
     localAddress:r.localAddress,localPort:r.localPort,peerAddress:r.peerAddress,peerPort:r.peerPort,
     pid:r.pid,process:r.process})),truncated:rows.length>(i.limit??200)};
 }
 case 'screen_capture':{
   const monitors=await screen.listDisplays();
   const selected=i.monitor===undefined?undefined:monitors[i.monitor];
   if(i.monitor!==undefined&&!selected)throw Error('SCREEN_UNAVAILABLE: monitor not found');
   const buffer=await screen({format:'png',...(selected?{screen:selected.id}:{})});
   let image=sharp(buffer);
   if(i.rect)image=image.extract(i.rect);
   image=image.resize({width:i.maxWidth??1920,height:i.maxHeight??1080,fit:'inside',withoutEnlargement:true});
   const output=i.format==='png'?await image.png().toBuffer():await image.jpeg({quality:Math.round((i.quality??0.8)*100)}).toBuffer();
   const meta=await sharp(output).metadata();
   return{base64:output.toString('base64'),mimeType:i.format==='png'?'image/png':'image/jpeg',
     width:meta.width,height:meta.height,sizeBytes:output.length,timestamp:new Date().toISOString()};
 }
 }
 throw Error('SYSTEM_TOOL_NOT_IMPLEMENTED: '+name);
}
export async function networkTool(name:string,i:I){
 if(name==='net_probe'){
   const began=Date.now(),timeout=i.timeoutMs??5000;
   if(i.mode==='dns'){
     const records=await Promise.race([
       i.recordType==='A'||i.recordType==='AAAA'?lookup(i.hostname,{all:true,family:i.recordType==='AAAA'?6:4}):
       resolveDns(i.hostname,i.recordType??'A'),
       new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('DNS_TIMEOUT')),timeout))
     ]);
     return {mode:'dns',hostname:i.hostname,records,durationMs:Date.now()-began};
   }
   if(i.mode==='tcp'){
     return await new Promise((resolve,reject)=>{
       const socket=tcpConnect({host:i.host,port:i.port});
       socket.setTimeout(timeout,()=>socket.destroy(Error('TCP_TIMEOUT')));
       socket.once('connect',()=>{socket.end();resolve({connected:true,host:i.host,port:i.port,durationMs:Date.now()-began});});
       socket.once('error',(error:NodeJS.ErrnoException)=>resolve({
         mode:'tcp',connected:false,host:i.host,port:i.port,
         errorCode:error.code??error.message,errorMessage:error.message,
         durationMs:Date.now()-began
       }));
     });
   }
   if(i.mode==='tls'){
     return await new Promise((resolve,reject)=>{
       const socket=tlsConnect({host:i.host,port:i.port??443,servername:isIP(i.host)?undefined:i.host,rejectUnauthorized:true});
       socket.setTimeout(timeout,()=>socket.destroy(Error('TLS_TIMEOUT')));
       socket.once('secureConnect',()=>{
         const cert=socket.getPeerCertificate();
         const result={connected:true,authorized:socket.authorized,protocol:socket.getProtocol(),
           subject:cert.subject,issuer:cert.issuer,expiresAt:cert.valid_to,durationMs:Date.now()-began};
         socket.end();resolve(result);
       });
       socket.once('error',(error:NodeJS.ErrnoException)=>resolve({
         mode:'tls',connected:false,host:i.host,port:i.port??443,
         errorCode:error.code??error.message,errorMessage:error.message,
         durationMs:Date.now()-began
       }));
     });
   }
 }
 if(name==='http_request'){
   const started=Date.now(),controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),i.timeoutMs??5000);
   try{
     const response=await fetch(i.url,{method:i.method??'GET',headers:i.headers??{},
       body:i.body,redirect:i.redirect??'follow',signal:controller.signal});
     const reader=response.body?.getReader();
     const sizeLimit=i.maxResponseBytes??65536;
     const chunks:Uint8Array[]=[];let total=0,truncated=false;
     if(reader)while(true){
       const {done,value}=await reader.read();if(done)break;
       if(total+value.byteLength>sizeLimit){chunks.push(value.slice(0,Math.max(0,sizeLimit-total)));truncated=true;await reader.cancel();break;}
       chunks.push(value);total+=value.byteLength;
     }
     const bytes=Buffer.concat(chunks.map(x=>Buffer.from(x)));
     const headers=Object.fromEntries([...response.headers].filter(([key])=>!['set-cookie','authorization','proxy-authenticate'].includes(key.toLowerCase())));
     return{url:response.url,status:response.status,ok:response.ok,headers,durationMs:Date.now()-started,
       contentType:response.headers.get('content-type'),body:limited(bytes.toString('utf8'),sizeLimit),truncated};
   }finally{clearTimeout(timer);}
 }
 throw Error('NETWORK_TOOL_NOT_IMPLEMENTED: '+name);
}
