import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backgroundWindow} from '../dist/background-window.js';
import {OutputWatchHub} from '../dist/output-watch.js';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=2500){
 const deadline=Date.now()+ms;
 while(Date.now()<deadline){if(check())return;await delay(25);}
 throw Error('TIMEOUT_WAITING_FOR_OUTPUT_EVENT');
}
test('background footer folds at five rows with accurate hidden count',()=>{
 const tasks=['A','B','C','D','E','F'];
 let window=backgroundWindow(tasks,0,5);
 assert.deepEqual(window.visible,['A','B','C','D']);
 assert.equal(window.hidden,2);
 assert.equal(window.rows,5);
 window=backgroundWindow(tasks,5,5);
 assert.deepEqual(window.visible,['C','D','E','F']);
 assert.equal(window.start,2);
 assert.equal(window.hidden,2);
 assert.deepEqual(backgroundWindow(tasks.slice(0,5),4,5).visible,tasks.slice(0,5));
 assert.equal(backgroundWindow(tasks.slice(0,5),4,5).hidden,0);
 const compact=backgroundWindow(tasks,4,3);
 assert.equal(compact.visible.length,2);
 assert.equal(compact.hidden,4);
 assert.deepEqual(backgroundWindow(['A'],0,5).visible,['A']);
});
test('output watcher starts only with a subscriber, tracks selected batch IDs and cleans up',async()=>{
 const root=mkdtempSync(join(tmpdir(),'deskbeacon-watch-'));
 const hub=new OutputWatchHub(root);
 const owner={};
 const events=[];
 try{
  assert.equal(hub.watcher,undefined);
  hub.set(owner,['taskA','batch:1'],change=>events.push(change));
  assert.ok(hub.watcher);
  await delay(80);
  writeFileSync(join(root,'taskA.out'),'a');
  writeFileSync(join(root,'batch_1.err'),'error');
  await until(()=>events.some(e=>e.taskId==='taskA')&&events.some(e=>e.taskId==='batch:1'));
  assert.equal(events.find(e=>e.taskId==='batch:1').size,5);
  const prior=events.length;
  hub.set(owner,['batch:1'],change=>events.push(change));
  await delay(120);
  appendFileSync(join(root,'taskA.out'),'old');
  appendFileSync(join(root,'batch_1.err'),'!');
  await until(()=>events.some(e=>e.taskId==='batch:1'&&e.size===6));
  assert.equal(events.filter(e=>e.taskId==='taskA').length,events.slice(0,prior).filter(e=>e.taskId==='taskA').length);
  hub.delete(owner);
  assert.equal(hub.watcher,undefined);
  assert.equal(hub.pending.size,0);
 }finally{hub.delete(owner);rmSync(root,{recursive:true,force:true});}
});
