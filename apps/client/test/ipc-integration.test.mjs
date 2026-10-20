import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {join} from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'db-ipc-events-'));
process.env.USERPROFILE=root;
process.env.HOME=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'?'\\\\.\\pipe\\db-ipc-test-'+process.pid:join(root,'socket');
const {startIpc}=await import('../dist/ipc.js');
const {LiveIpcClient}=await import('../dist/ipc-live.js');
const {dataDir}=await import('../dist/daemon.js');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(pred,ms=2000){
 const end=Date.now()+ms;
 while(Date.now()<end){if(pred())return;await wait(25);}
 throw Error('EVENT_NOT_RECEIVED');
}
test('IPC v2 multiplexes requests and events and output watchers are opt-in',async()=>{
 const daemon=new EventEmitter();
 let lastIncludeBackground;
 daemon.status=async (includeBackground=true)=>{
  lastIncludeBackground=includeBackground;
  return {state:'connected',active:[],activityRevision:3,latencyMs:12,
   ...(includeBackground?{background:[{id:'legacy'}]}:{})};
 };
 daemon.activityList=()=>({rows:[],hasMore:false,total:0});
 daemon.supervisor={active:()=>[],latestLine:()=>''};
 const server=startIpc(daemon);
 const events=[];
 let client;
 try{
  await once(server,'listening');
  client=await LiveIpcClient.connect(event=>events.push(event),()=>{});
  const watch=await client.request({action:'watch',topics:['runtime']});
  assert.deepEqual(watch.topics,['runtime']);
  const [lite,normal,page]=await Promise.all([
   client.request({action:'status-lite'}),
   client.request({action:'status'}),
   client.request({action:'activity-list',limit:50})
  ]);
  assert.equal(lite.background,undefined);
  assert.deepEqual(normal.background,[{id:'legacy'}]);
  assert.deepEqual(page.rows,[]);
  assert.equal(lastIncludeBackground,true);
  daemon.emit('change');
  await until(()=>events.some(event=>event.topic==='runtime.changed'));
  const dir=join(dataDir,'output');
  mkdirSync(dir,{recursive:true});
  const filename=join(dir,'activity-123.out');
  writeFileSync(filename,'first');
  await client.request({action:'output.watchSet',taskIds:['activity-123']});
  appendFileSync(filename,'-second');
  await until(()=>events.some(e=>e.topic==='output.changed'&&e.taskId==='activity-123'));
  const tail=await client.request({action:'output-tail',operationId:'activity-123',stream:'stdout'});
  assert.equal(tail.text,'first-second');
  const count=events.length;
  await client.request({action:'output.watchSet',taskIds:[]});
  appendFileSync(filename,'-third');
  await wait(220);
  assert.equal(events.length,count,'no events after unsubscription');
  client.close();client=null;
  await wait(50);
  assert.equal(daemon.listenerCount('change'),0);
 }finally{
  client?.close();
  await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});
 }
});
