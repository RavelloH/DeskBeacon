import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'deskbeacon-lock-recovery-'));
process.env.DESKBEACON_DATA_DIR=dir;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'?
 '\\\\.\\pipe\\deskbeacon-lock-test-'+process.pid:join(dir,'runtime.sock');
const {lockOwnerAlive,ownLockRecord}=await import('../dist/process-identity.js');
const {startIpc,closeIpc}=await import('../dist/ipc.js');
const {supervisorRunning}=await import('../dist/service-supervisor.js');
const runtimeLock=join(dir,'runtime.lock'),supervisorLock=join(dir,'supervisor.lock');
let other,server;
try{
 const own=ownLockRecord('runtime');
 assert.equal(lockOwnerAlive(own,'runtime'),true,'current process fingerprint must be recognized');
 assert.equal(lockOwnerAlive({...own,processStartedAt:own.processStartedAt-3600000},'runtime'),false,
  'a recycled PID with a mismatched creation time is not our runtime');
 assert.equal(lockOwnerAlive({pid:0},'runtime'),false);

 writeFileSync(runtimeLock,JSON.stringify({...own,processStartedAt:own.processStartedAt-3600000}));
 server=startIpc(new EventEmitter());
 await once(server,'listening');
 await closeIpc(server);server=null;
 assert.equal(existsSync(runtimeLock),false,'stale runtime lock is removed on IPC close');

 writeFileSync(supervisorLock,JSON.stringify(ownLockRecord('supervisor')));
 assert.equal(supervisorRunning(),true);
 writeFileSync(supervisorLock,JSON.stringify({...ownLockRecord('supervisor'),processStartedAt:own.processStartedAt-3600000}));
 assert.equal(supervisorRunning(),false,'stale supervisor lock is rejected');

 // 0.3.0 stored only {pid}. Simulate the original incident where Windows
 // recycled that PID for a completely different executable.
 if(process.platform==='win32'){
  other=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20'],
   {windowsHide:true,stdio:'ignore'});
  await once(other,'spawn');
  assert.ok(other.pid);
  assert.equal(lockOwnerAlive({pid:other.pid},'runtime'),false,
   'legacy PID-only lock must reject an unrelated live Windows process');
  writeFileSync(runtimeLock,JSON.stringify({pid:other.pid}));
  server=startIpc(new EventEmitter());
  await once(server,'listening');
  await closeIpc(server);server=null;
  assert.equal(existsSync(runtimeLock),false);
 }
 console.log('PASS runtime/supervisor locks reject recycled PIDs and legacy unrelated owners');
}finally{
 if(server)try{await closeIpc(server);}catch{}
 if(other)try{other.kill('SIGKILL');}catch{}
 rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
