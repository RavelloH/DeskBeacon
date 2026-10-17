import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskSupervisor } from '../dist/process.js';
const base=mkdtempSync(join(tmpdir(),'db-job-test-'));
const db=new DatabaseSync(join(base,'state.sqlite'));
const supervisor=new TaskSupervisor(db,join(base,'output'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function awaitPid(path) {
 for(let t=0;t<60;t++){if(existsSync(path))return Number(readFileSync(path,'utf8'));
 await wait(50);}throw Error('Child PID not recorded');
}
const source=pidfile=>[
'const cp=require("node:child_process");',
'const fs=require("node:fs");',
'const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});',
'fs.writeFileSync('+JSON.stringify(pidfile)+',String(child.pid));',
'setInterval(()=>{},1000);'
].join('');
try{
 const pidfile=join(base,'grandchild-pid.txt');
 const fg=supervisor.foreground('job-timeout','Nested foreground process',{
  mode:'program',program:process.execPath,args:['-e',source(pidfile)]},950);
 const grandchild=await awaitPid(pidfile);
 assert.ok(alive(grandchild),'grandchild never started');
 const outcome=await fg;
 assert.equal(outcome.timedOut,true,JSON.stringify(outcome));
 assert.equal(outcome.cleanup,'windows-job-object');
 for(let n=0;n<30&&alive(grandchild);n++)await wait(100);
 assert.equal(alive(grandchild),false,'detached grandchild leaked after timeout');
 console.log('PASS Job Object timeout kills detached grandchild; child PID',grandchild);
 const pidfile2=join(base,'background-grandchild-pid.txt');
 const bg=await supervisor.startBackground('job-bg','Nested background process',{
  mode:'program',program:process.execPath,args:['-e',source(pidfile2)]});
 const grandchild2=await awaitPid(pidfile2);
 assert.ok(alive(grandchild2));
 const stop=await supervisor.stop('job-bg');
 assert.equal(stop.stopped,true);
 for(let n=0;n<30&&alive(grandchild2);n++)await wait(100);
 assert.equal(alive(grandchild2),false,'detached grandchild leaked after background stop');
 console.log('PASS Job Object explicit background stop kills detached grandchild; child PID',grandchild2);
 const pnpm=await supervisor.foreground('job-pnpm','Windows pnpm shim',{mode:'program',program:'pnpm',args:['--version']},8000);
 assert.equal(pnpm.exitCode,0,'Native launcher pnpm.cmd '+pnpm.stderr);
 assert.match(pnpm.stdout,/\d+\.\d+\.\d+/);
 console.log('PASS Native Windows cmd shim runs pnpm');
 const ps=await supervisor.foreground('job-powershell','Native Windows PowerShell profile',{mode:'shell',script:'Write-Output 616161',shellProfile:'pwsh'},8000);
 assert.equal(ps.exitCode,0,'Native launcher pwsh '+ps.stderr);
 assert.ok(ps.stdout.includes('616161'));
 console.log('PASS Native Windows shell profile pwsh');
}finally{db.close();rmSync(base,{recursive:true,force:true});}

