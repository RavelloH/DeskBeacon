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
 const id='test-batch-stop';
 const command=(name)=>({commandId:name,mode:'program',program:'node',args:['-e','setInterval(()=>{},1000)']});
 const pending=manager.batch(id,'Cancellation regression',[{parallel:true,commands:[command('a'),command('b')]},
  {parallel:false,commands:[{commandId:'never',mode:'program',program:'node',args:['-e','console.log("SHOULD NOT RUN")']}]}],15000);
 await new Promise(resolve=>setTimeout(resolve,450));
 const cancelled=await manager.stop(id);
 assert.equal(cancelled.processesSignalled,2);
 const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('Batch did not stop')),8000))]);
 assert.equal(result.stages.length,1,'Cancelled batch must not run later stage');
 assert.equal(manager.active().length,0,'All foreground child tasks must be reaped');
 console.log('PASS Batch cancel cascades to two subprocesses; no later stage');
 const started=Date.now();
 const timedOut=await manager.foreground('test-timeout','Finite foreground timeout',
  {mode:'program',program:'node',args:['-e','setInterval(()=>{},1000)']},350);
 assert.equal(timedOut.timedOut,true);
 assert.equal(manager.active().length,0);
 assert.ok(Date.now()-started<8000);
 console.log('PASS Foreground timeout reaps direct process in '+(Date.now()-started)+'ms');
}finally{db.close();rmSync(testDir,{recursive:true,force:true});}
