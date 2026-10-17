import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const tmp=mkdtempSync(join(tmpdir(),'db-job-crash-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const daemon=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/job-parent-driver.mjs',import.meta.url)),tmp],{
  windowsHide:true,stdio:['ignore','pipe','pipe']
});
let stderr=''; daemon.stderr.on('data',b=>stderr+=b.toString());
try{
 const pidfile=join(tmp,'daemon-grandchild.txt');
 let spawned=0;
 for(let i=0;i<100;i++){if(existsSync(pidfile)){spawned=Number(readFileSync(pidfile,'utf8'));break;}await sleep(50);}
 assert.ok(spawned,stderr||'daemon failed to spawn grandchild');
 assert.ok(alive(spawned),'grandchild did not start');
 // Terminate daemon without executing shutdown hooks. Native launcher must watch parent and kill Job.
 daemon.kill('SIGKILL');
 await new Promise(resolve=>daemon.once('exit',resolve));
 for(let i=0;i<60&&alive(spawned);i++)await sleep(75);
 assert.equal(alive(spawned),false,'grandchild survived ungraceful daemon termination');
 console.log('PASS kernel Job Object closes when owning Daemon is killed; detached grandchild PID',spawned);
}finally{
 try{daemon.kill('SIGKILL');}catch{}
 rmSync(tmp,{recursive:true,force:true});
}

