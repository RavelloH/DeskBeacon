import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-journal-ipc-v2-'));
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'
 ? '\\\\.\\pipe\\deskbeacon-journal-v2-'+process.pid:join(root,'daemon.sock');
const [{ClientDaemon},{startIpc},{LiveIpcClient}]=await Promise.all([
 import('../dist/daemon.js'),import('../dist/ipc.js'),import('../dist/ipc-live.js')]);
const daemon=new ClientDaemon({url:'https://example.invalid',deviceId:'ipc-fixture',accessToken:'TEST',clientId:'TEST',deviceName:'Test'});
daemon.send=()=> 'fake';
daemon.sendSafe=async()=> 'fake';
const server=startIpc(daemon),events=[];
let client;
try{
 await new Promise(resolve=>setTimeout(resolve,60));
 client=await LiveIpcClient.connect(event=>events.push(event),()=>{},2500);
 await client.request({action:'watch',topics:['runtime']});
 await client.request({action:'output.watchSet',taskIds:['live-stream']});
 const tool='exec_foreground',input={description:'event stream',command:{mode:'program',program:'node',
  args:['-e',"setTimeout(()=>process.stdout.write('journal-live-event'),100)"],cwd:root},timeoutMs:15000};
 await daemon.dispatch({type:'operation.dispatch',operationId:'live-stream',toolName:tool,input,grantId:'test',actorName:'Test',
  requestHash:createHash('sha256').update(JSON.stringify([tool,input])).digest('hex'),
  expiresAt:new Date(Date.now()+60000).toISOString()});
 const deadline=Date.now()+2000;
 while(Date.now()<deadline&&!events.some(e=>e.topic==='output.changed'))await new Promise(r=>setTimeout(r,20));
 assert.ok(events.some(e=>e.topic==='output.changed'&&e.taskId==='live-stream'),'new journal must notify subscribed TUI');
 const p=await client.request({action:'output',operationId:'live-stream',stream:'stdout',maxBytes:1024});
 assert.equal(p.text,'journal-live-event');
 console.log('PASS writer-driven output.changed subscription and JSONL IPC stdout paging');
}finally{client?.close();await new Promise(resolve=>server.close(resolve));await daemon.shutdown();rmSync(root,{recursive:true,force:true});}
