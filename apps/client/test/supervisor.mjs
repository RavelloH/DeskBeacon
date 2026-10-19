import { DatabaseSync } from 'node:sqlite';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskSupervisor } from '../dist/process.js';

const testDir=mkdtempSync(join(tmpdir(),'deskbeacon-supervisor-'));
const db=new DatabaseSync(join(testDir,'state.sqlite'));
const manager=new TaskSupervisor(db,join(testDir,'output'));
try{
 const id='test-foreground-stop';
 const pending=manager.foreground(id,'Cancellation regression',
  {mode:'program',program:'node',args:['-e','setInterval(()=>{},1000)']},15000);
 await new Promise(resolve=>setTimeout(resolve,450));
 const cancelled=await manager.stop(id);
 assert.equal(cancelled.processesSignalled,1);
 const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('Foreground did not stop')),8000))]);
 assert.equal(result.cancelled,true,'Stopped command must report cancellation');
 assert.equal(manager.active().length,0,'Foreground process must be reaped');
 console.log('PASS Foreground cancellation reaps managed process');
 if(process.platform!=='win32'){
  const id='test-background-spawn-error';
  await assert.rejects(manager.startBackground(id,'Invalid executable regression',
   {mode:'program',program:'/definitely/nonexistent/deskbeacon-test-executable'}),
   /SPAWN_FAILED/);
  assert.equal(manager.get(id),null,'failed spawn must not register a phantom running task');
  assert.equal(manager.active().some(t=>t.id===id),false);
  console.log('PASS background invalid executable rejects and leaves no phantom task');
 }

 const started=Date.now();
 const timedOut=await manager.foreground('test-timeout','Finite foreground timeout',
  {mode:'program',program:'node',args:['-e','setInterval(()=>{},1000)']},350);
 assert.equal(timedOut.timedOut,true);
 assert.equal(manager.active().length,0);
 assert.ok(Date.now()-started<8000);
 console.log('PASS Foreground timeout reaps direct process in '+(Date.now()-started)+'ms');
}finally{db.close();rmSync(testDir,{recursive:true,force:true});}
