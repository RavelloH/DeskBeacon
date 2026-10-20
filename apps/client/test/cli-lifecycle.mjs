import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'deskbeacon-lifecycle-'));
const cli=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const pipe=process.platform==='win32'?'\\\\.\\pipe\\deskbeacon-lifecycle-'+process.pid:join(dir,'daemon.sock');
const env={...process.env,DESKBEACON_DATA_DIR:dir,DESKBEACON_IPC_PATH:pipe,NODE_NO_WARNINGS:'1'};
writeFileSync(join(dir,'config.json'),JSON.stringify({
  url:'http://127.0.0.1:65530',deviceId:'lifecycle-test',
  clientId:'lifecycle-test',deviceName:'Lifecycle test',
  accessToken:'isolated-test-token',accessTokenExpiresAt:Date.now()+3600000
}));
process.env.DESKBEACON_DATA_DIR=dir;
process.env.DESKBEACON_IPC_PATH=pipe;
const {requestIpc}=await import('../dist/ipc.js');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connected(){
 for(let i=0;i<100;i++){
   try{return await requestIpc({action:'status'},200);}catch{}
   await wait(100);
 }
 throw Error('Runtime failed to bind IPC');
}
async function disconnected(){
 for(let i=0;i<100;i++){
   try{await requestIpc({action:'status'},200);}catch{return;}
   await wait(100);
 }
 throw Error('Runtime failed to release IPC');
}
function call(...args){
 const r=spawnSync(process.execPath,[cli,...args],{cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:18000});
 assert.equal(r.status,0,'CLI '+args.join(' ')+'\n'+r.stderr+'\n'+r.stdout);
 return r.stdout;
}
const worker=spawn(process.execPath,[cli,'__service_run'],{cwd:dir,env,windowsHide:true,stdio:'ignore'});
try{
 const running=await connected();
 assert.equal(running.runtimeMode,'background');
 assert.equal(running.deviceId,'lifecycle-test');
 console.log('PASS headless background Runtime accepts local IPC');
 assert.match(call('service','start'),/already running/);
 console.log('PASS second CLI does not create a duplicate Runtime');
 const status=call('service','status');
 assert.ok(status.includes('background'));
 console.log('PHASE stopping background');
 assert.match(call('service','stop'),/stopped/);
 console.log('PHASE waiting for IPC release');
 await disconnected();
 assert.equal(existsSync(join(dir,'runtime.lock')),false);
 console.log('PASS service stop releases runtime lock and IPC');
 assert.match(call('help'),/service <start\|stop\|restart>/);
 assert.match(call('--version'),/\d+\.\d+\.\d+/);
 const noTty=spawnSync(process.execPath,[cli],{cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:6000});
 assert.equal(noTty.status,1);
 assert.match(noTty.stderr,/interactive terminal/);
 console.log('PASS CLI help/version and headless root guard');
}finally{
 try{worker.kill('SIGKILL');}catch{}
 await new Promise(resolve=>{
  if(worker.exitCode!==null||worker.signalCode!==null)return resolve();
  worker.once('exit',resolve);setTimeout(resolve,2500);
 });
 try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});}catch(e){console.error('Temporary fixture cleanup deferred:',String(e));}
}
