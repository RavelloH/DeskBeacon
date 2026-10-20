import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-supervisor-ci-'));
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const client=join(repo,'apps/client');
const cli=join(client,'dist','index.js');
const socket=process.platform==='win32'?
 '\\\\.\\pipe\\deskbeacon-recovery-test-'+process.pid:join(root,'daemon.sock');
const env={...process.env,DESKBEACON_DATA_DIR:root,DESKBEACON_IPC_PATH:socket};
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=socket;
mkdirSync(root,{recursive:true});
writeFileSync(join(root,'config.json'),JSON.stringify({
 url:'http://127.0.0.1:9',deviceId:'ci-recovery',accessToken:'test-token',
 clientId:'ci-client',deviceName:'CI Recovery Test'
}));
const {requestIpc,subscribeIpc}=await import('../dist/ipc.js');
const run=(...args)=>{
 const run=spawnSync(process.execPath,[cli,...args],{cwd:repo,env,
  encoding:'utf8',timeout:24000,windowsHide:true});
 if(run.error)throw run.error;
 assert.equal(run.status,0,args.join(' ')+' failed: '+run.stderr+'\n'+run.stdout);
 return run.stdout.trim();
};
const pidFile=join(root,'runtime.lock');
const supervisorFile=join(root,'supervisor.lock');
const readPid=file=>JSON.parse(readFileSync(file,'utf8')).pid;
const wait=async(check,deadlineMs=16000)=>{
 const deadline=Date.now()+deadlineMs;
 while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch{}await delay(150);}
 throw Error('timed out awaiting expected runtime state');
};
try{
 console.log('=== start isolated service ===');
 run('service','start');
 assert.ok(existsSync(supervisorFile),'supervisor lock missing');
 const initialPid=readPid(pidFile);
 const superPid=readPid(supervisorFile);
 assert.notEqual(initialPid,superPid,'watchdog and Runtime must be separate processes');
 let state=await requestIpc({action:'status'},1800);
 assert.equal(state.runtimeMode,'background');
 console.log('PASS background Runtime, supervisor and IPC started',initialPid,superPid);

 let disconnected=false;
 const dispose=subscribeIpc(()=>{},()=>{disconnected=true;});
 await delay(250);
 // Abrupt OS-level termination intentionally bypasses graceful SIGTERM handlers.
 if(process.platform==='win32'){
  const killed=spawnSync('taskkill.exe',['/F','/PID',String(initialPid)],
   {encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(killed.status,0,'taskkill failed: '+killed.stderr);
 }else{process.kill(initialPid,'SIGKILL');}
 await wait(()=>disconnected,5000);
 const secondPid=await wait(async()=>{
  if(!existsSync(pidFile))return null;
  const pid=readPid(pidFile);
  if(pid===initialPid)return null;
  const current=await requestIpc({action:'status'},1500);
  return current.runtimeMode==='background'?pid:null;
 },18000);
 assert.notEqual(secondPid,initialPid);
 assert.equal(readPid(supervisorFile),superPid,'supervisor should survive crash');
 dispose();
 console.log('PASS watchdog restored Runtime after forced crash and IPC recovered',secondPid);

 // A graceful worker exit without a matching service-stop request must also
 // be healed; otherwise a stray IPC 'exit' could leave the TUI offline forever.
 await requestIpc({action:'exit'},2000);
 const thirdPid=await wait(async()=>{
  if(!existsSync(pidFile))return null;
  const pid=readPid(pidFile);
  if(pid===secondPid)return null;
  const current=await requestIpc({action:'status'},1500);
  return current.runtimeMode==='background'?pid:null;
 },18000);
 assert.notEqual(thirdPid,secondPid);
 assert.equal(readPid(supervisorFile),superPid,
  'watchdog must remain active following unexpected clean worker exit');
 console.log('PASS watchdog restored Runtime after unexpected exit code 0',thirdPid);

 const status=run('service','status');
 assert.ok(status.includes('background'),'service status should recognize recovered child');
 run('service','stop');
 await wait(()=>!existsSync(pidFile)&&!existsSync(supervisorFile),10000);
 await delay(750);
 assert.ok(!existsSync(pidFile)&&!existsSync(supervisorFile),
  'normal service stop must not trigger another restart');
 const log=readFileSync(join(root,'service.log'),'utf8');
 assert.match(log,/restart scheduled/);
 assert.match(log,/runtime spawned/);
 assert.match(log,/supervisor stopped/);
 console.log('PASS normal service stop prevents restarts and bounded diagnostics retained');
}catch(e){
 console.error('SUPERVISOR_CI_FAILED',e);
 if(existsSync(root)){
  const logPath=join(root,'service.log');
  if(existsSync(logPath))console.error(readFileSync(logPath,'utf8').slice(-4000));
 }
 process.exitCode=1;
}finally{
 try{run('service','stop');}catch{}
 await delay(300);
 rmSync(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
