import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-restart-regression-'));
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const entry=join(repo,'apps/client/dist/index.js');
const pipe=process.platform==='win32'?'\\\\.\\pipe\\deskbeacon-restart-test-'+process.pid:join(root,'daemon.sock');
const env={...process.env,DESKBEACON_DATA_DIR:root,DESKBEACON_IPC_PATH:pipe};
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=pipe;
writeFileSync(join(root,'config.json'),JSON.stringify({url:'http://127.0.0.1:9',deviceName:'restart-test',deviceId:'isolated-device',clientId:'isolated-device',accessToken:'isolated-token'}));
const {requestIpc,subscribeIpc}=await import('../dist/ipc.js');
const run=(...args)=>{
 const begun=Date.now(),r=spawnSync(process.execPath,[entry,...args],{env,cwd:repo,encoding:'utf8',timeout:35000,windowsHide:true});
 const durationMs=Date.now()-begun;
 if(r.error)throw r.error;
 assert.equal(r.status,0,args.join(' ')+' failed after '+durationMs+'ms\n'+r.stdout+'\n'+r.stderr);
 return {stdout:r.stdout,durationMs};
};
const lock=(name)=>JSON.parse(readFileSync(join(root,name+'.lock'),'utf8')).pid;
try{
 run('service','start');
 const original=lock('runtime');
 for(let i=0;i<5;i++){
  let disconnected=false;
  const unsubscribe=subscribeIpc(()=>{},()=>{disconnected=true;});
  await pause(120);
  const r=run('service','restart');
  // spawnSync blocks this test process's event loop; receive socket close after it returns.
  await pause(100);
  unsubscribe();
  assert.ok(r.stdout.includes('service stopped'),r.stdout);
  assert.ok(r.stdout.includes('service started'),r.stdout);
  assert.ok(disconnected,'Long-running IPC subscriber remained connected during restart '+i);
  const current=await requestIpc({action:'status'},1500);
  assert.equal(current.runtimeMode,'background');
  assert.ok(lock('supervisor')>0);
  assert.ok(lock('runtime')>0);
  assert.ok(r.durationMs<19000,'restart was unusually slow ('+r.durationMs+'ms)');
  console.log('PASS restart',i+1,'durationMs',r.durationMs,'supervisorPid',lock('supervisor'),'runtimePid',lock('runtime'));
 }
 assert.notEqual(original,lock('runtime'));
 run('service','stop');
 assert.equal(existsSync(join(root,'supervisor.lock')),false);
 assert.equal(existsSync(join(root,'runtime.lock')),false);
 const log=readFileSync(join(root,'logs','service.jsonl'),'utf8');
 assert.match(log,/supervisor.stopped/);
 assert.doesNotMatch(log,/supervisor.restart_limit/);
 console.log('PASS five successive isolated service restart operations with live IPC subscribers; clean locks and normal service logs');
}finally{
 try{run('service','stop');}catch{}
 await pause(300);
 rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
