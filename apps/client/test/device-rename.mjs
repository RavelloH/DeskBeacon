import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';

const dir=mkdtempSync(join(tmpdir(),'deskbeacon-rename-'));
const server=createServer();
const wss=new WebSocketServer({server});
let label='Existing KV name',changes=0;
const sockets=new Set();
wss.on('connection',ws=>{
 sockets.add(ws);ws.on('close',()=>sockets.delete(ws));
 ws.send(JSON.stringify({version:1,type:'device.ready',messageId:'ready-1',deviceId:'self',connectionEpoch:1,payload:{ready:true,deviceName:label}}));
 ws.on('message',raw=>{
  if(raw.toString()==='ping'){ws.send('pong');return;}
  const message=JSON.parse(raw.toString());
  if(message.type==='device.rename'){
   label=message.payload.name;changes++;
   ws.send(JSON.stringify({version:1,type:'device.name.updated',messageId:'ack-'+changes,
    deviceId:'self',connectionEpoch:1,payload:{name:label,inReplyTo:message.messageId}}));
  }
 });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const cli=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const ipc=process.platform==='win32'?'\\\\.\\pipe\\deskbeacon-rename-'+process.pid:join(dir,'daemon.sock');
const env={...process.env,DESKBEACON_DATA_DIR:dir,DESKBEACON_IPC_PATH:ipc,NODE_NO_WARNINGS:'1'};
writeFileSync(join(dir,'config.json'),JSON.stringify({
 url:'http://127.0.0.1:'+port,deviceId:'rename-test',clientId:'rename-test',
 deviceName:'Old local name',accessToken:'local-test-token',accessTokenExpiresAt:Date.now()+3600_000
}));
function launch(...args){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args],{cwd:dir,env,windowsHide:true});
  let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data.toString();});
  child.stderr.on('data',data=>{stderr+=data.toString();});
  child.once('error',reject);
  child.once('exit',code=>resolve({code,stdout,stderr}));
 });
}
const config=()=>JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));
let service;
try{
 const standalone=await launch('rename','Standalone Name');
 assert.equal(standalone.code,0,standalone.stderr);
 assert.match(standalone.stdout,/Device renamed to Standalone Name/);
 assert.equal(label,'Standalone Name');
 assert.equal(config().deviceName,'Standalone Name');
 console.log('PASS standalone CLI rename syncs server and local config');

 service=spawn(process.execPath,[cli,'__service_run'],{cwd:dir,env,windowsHide:true,stdio:'ignore'});
 process.env.DESKBEACON_DATA_DIR=dir;process.env.DESKBEACON_IPC_PATH=ipc;
 const {requestIpc}=await import('../dist/ipc.js');
 let active=false;
 for(let i=0;i<100;i++){
  try{active=(await requestIpc({action:'status'},500)).state==='connected';if(active)break;}catch{}
  await new Promise(r=>setTimeout(r,80));
 }
 assert.ok(active,'service must be connected');
 const online=await launch('rename','Online Service Name');
 assert.equal(online.code,0,online.stderr);
 assert.match(online.stdout,/Device renamed to Online Service Name/);
 assert.equal(label,'Online Service Name');
 assert.equal(config().deviceName,'Online Service Name');
 assert.equal((await requestIpc({action:'status'})).deviceName,'Online Service Name');
 console.log('PASS active background service rename updates server, config and live status');
 const stopped=await launch('service','stop');
 assert.equal(stopped.code,0,stopped.stderr);
}finally{
 if(service && service.exitCode===null){try{service.kill();}catch{}}
 await new Promise(resolve=>{
  if(!service||service.exitCode!==null||service.signalCode!==null)return resolve();
  service.once('exit',resolve);setTimeout(resolve,2000);
 });
 for(const ws of sockets)ws.terminate();
 await new Promise(resolve=>wss.close(resolve));
 await new Promise(resolve=>server.close(resolve));
 try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
}
