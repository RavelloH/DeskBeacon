import si from 'systeminformation';
import {cpus,freemem,networkInterfaces,totalmem} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);

async function windowsProcessOwners():Promise<Map<number,{name:string;user:string|null}>> {
 const map=new Map<number,{name:string;user:string|null}>();
 try{
  const script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,UserName | ConvertTo-Json -Compress";
  const {stdout}=await execFileAsync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,timeout:7000,maxBuffer:4*1024*1024});
  const rows=JSON.parse(stdout.trim()||'[]');
  for(const row of Array.isArray(rows)?rows:[rows]){
   if(Number.isInteger(row.Id))map.set(row.Id,{name:row.ProcessName,user:row.UserName??null});
  }
 }catch{/* Not all Windows service identities can query process owners. */}
 return map;
}

async function windowsNetstat(protocol:string):Promise<any[]> {
 const protocols=protocol==='all'?['tcp','udp']:[protocol];
 const results=await Promise.all(protocols.map(async value=>{
  const {stdout}=await execFileAsync('netstat',['-ano','-p',value],
    {windowsHide:true,timeout:7000,maxBuffer:8*1024*1024});
  return stdout;
 }));
 const split=(value:string)=>{
  const end=value.lastIndexOf(':');
  return {address:end>=0?value.slice(0,end).replace(/^\[|\]$/g,''):value,
    port:end>=0?Number(value.slice(end+1))||0:0};
 };
 const rows:any[]=[];
 for(const result of results)for(const line of result.split(/\r?\n/)){
  const match=/^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s+(?:(\S+)\s+)?(\d+)\s*$/i.exec(line);
  if(!match)continue;
  const [,protocol,local,peer,rawState,pid]=match;
  const l=split(local!),p=split(peer!);
  if(!l.port)continue;
  rows.push({protocol:protocol!.toLowerCase(),state:rawState?.toLowerCase()==='listening'||protocol?.toLowerCase()==='udp'?'listen':rawState?.toLowerCase()??'',
    localAddress:l.address,localPort:l.port,peerAddress:p.address,peerPort:p.port,pid:Number(pid)});
 }
 return rows;
}
import { lookup, resolve as resolveDns } from 'node:dns/promises';
import { connect as tcpConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import screen from 'screenshot-desktop';
import sharp from 'sharp';
import {networkFetch} from './outbound-network.js';
type I=Record<string,any>;
const limited=(s:string,max:number)=>s.length>max?s.slice(0,max):s;
export async function systemTool(name:string,i:I){
 switch(name){
 case 'system_snapshot':{
   const [load,disks]=await Promise.all([
     si.currentLoad(),
     i.includeDisks===false?Promise.resolve([]):si.fsSize()]);
   const cpu=cpus(),available=freemem(),total=totalmem();
   const network=i.includeNetwork===false?[]:Object.entries(networkInterfaces()).map(([name,addresses])=>({
     name,ip4:addresses?.find(x=>x.family==='IPv4')?.address??'',
     ip6:addresses?.find(x=>x.family==='IPv6')?.address??'',
     internal:addresses?.every(x=>x.internal)??false
   }));
   return {timestamp:new Date().toISOString(),platform:process.platform,architecture:process.arch,
     cpu:{model:cpu[0]?.model??'unknown',cores:cpu.length,loadPercent:load.currentLoad},
     memory:{totalBytes:total,availableBytes:available,usedBytes:total-available},
     disks:(disks as any[]).map(x=>({mount:x.mount,totalBytes:x.size,usedBytes:x.used,usedPercent:x.use})),
     network};
 }
 case 'system_processes':{
   const [all,owners]=await Promise.all([
     si.processes(),process.platform==='win32'?windowsProcessOwners():Promise.resolve(new Map<number,{name:string;user:string|null}>())
   ]);let rows=all.list as any[];
   if(i.pid)rows=rows.filter(p=>p.pid===i.pid);
   if(i.name)rows=rows.filter(p=>String(p.name).toLowerCase().includes(String(i.name).toLowerCase()));
   rows.sort((a,b)=>i.sortBy==='name'?String(a.name).localeCompare(String(b.name)):
     i.sortBy==='pid'?a.pid-b.pid:(b[i.sortBy??'cpu']??0)-(a[i.sortBy??'cpu']??0));
   return {processes:rows.slice(0,i.limit??200).map(p=>({pid:p.pid,parentPid:p.parentPid,name:p.name,
     cpuPercent:p.cpu,memoryBytes:Math.round((p.memRss??0)*1024),started:p.started,user:p.user||owners.get(p.pid)?.user||null})),
     totalMatches:rows.length,truncated:rows.length>(i.limit??200)};
 }
 case 'net_ports':{
   const [all,owners]=await Promise.all([
     process.platform==='win32'?windowsNetstat(i.protocol??'tcp'):si.networkConnections(),
     process.platform==='win32'?windowsProcessOwners():Promise.resolve(new Map<number,{name:string;user:string|null}>())
   ]);
   let rows=all as any[];
   if(i.protocol&&i.protocol!=='all')rows=rows.filter(r=>String(r.protocol).toLowerCase().includes(i.protocol));
   if(i.state&&i.state!=='all')rows=rows.filter(r=>i.state==='listen'?/listen/i.test(r.state):/established/i.test(r.state));
   if(i.port)rows=rows.filter(r=>r.localPort===String(i.port)||r.localPort===i.port);
   if(i.pid)rows=rows.filter(r=>r.pid===i.pid);
   if(i.address)rows=rows.filter(r=>String(r.localAddress).includes(i.address));
   return{connections:rows.slice(0,i.limit??200).map(r=>({protocol:r.protocol,state:r.state,
     localAddress:r.localAddress,localPort:Number(r.localPort)||0,peerAddress:r.peerAddress,peerPort:r.peerPort?Number(r.peerPort):null,
     pid:r.pid,process:r.process||owners.get(r.pid)?.name||null})),truncated:rows.length>(i.limit??200)};
 }
 case 'screen_capture':{
   if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)
     throw Error('SCREEN_UNAVAILABLE: no graphical desktop session (DISPLAY/WAYLAND_DISPLAY)');
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
     const response=await networkFetch(i.url,{method:i.method??'GET',headers:i.headers??{},
       body:i.body,redirect:i.redirect??'follow',signal:controller.signal});
     const sizeLimit=i.maxResponseBytes??65536;
     const chunks:Buffer[]=[];let total=0,truncated=false;
     if(response.body)for await(const part of response.body){
       const value=Buffer.isBuffer(part)?part:Buffer.from(part);
       if(total+value.byteLength>sizeLimit){
         chunks.push(value.subarray(0,Math.max(0,sizeLimit-total)));
         truncated=true;(response.body as import('node:stream').Readable).destroy();break;
       }
       chunks.push(value);total+=value.byteLength;
     }
     const bytes=Buffer.concat(chunks.map(x=>Buffer.from(x)));
     const headers=Object.fromEntries([...response.headers].filter(([key])=>!['set-cookie','authorization','proxy-authenticate'].includes(key.toLowerCase())));
     return{url:response.url,status:response.status,ok:response.ok,headers,durationMs:Date.now()-started,
       contentType:response.headers.get('content-type'),body:limited(bytes.toString('utf8'),sizeLimit),truncated};
   }catch(error){
     const cause=error instanceof Error?(error as Error & {cause?:{code?:string}}).cause:undefined;
     const code=cause?.code??(error instanceof Error?error.name:'HTTP_REQUEST_FAILED');
     throw Object.assign(new Error('HTTP_REQUEST_FAILED: '+code+' '+(error instanceof Error?error.message:String(error))),{code});
   }finally{clearTimeout(timer);}
 }
 throw Error('NETWORK_TOOL_NOT_IMPLEMENTED: '+name);
}
