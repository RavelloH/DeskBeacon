import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-exec-v2-'));
process.env.DESKBEACON_DATA_DIR=root;
const {ClientDaemon}=await import('../dist/daemon.js');
const {recordRelativePath}=await import('../dist/record-journal.js');
const daemon=new ClientDaemon({url:'https://example.invalid',deviceId:'test-device',accessToken:'TEST_ACCESS',clientId:'TEST_CLIENT',deviceName:'Test'});
daemon.send=function(){return 'fake-id'};
daemon.sendSafe=async function(){return 'fake-id'};
const call=async(id,tool,input)=>await daemon.dispatch({type:'operation.dispatch',operationId:id,toolName:tool,input,
 requestHash:createHash('sha256').update(JSON.stringify([tool,input])).digest('hex'),
 expiresAt:new Date(Date.now()+120_000).toISOString(),grantId:'grant-test',actorName:'Test'});
try{
 const input={description:'test stdout capture',command:{mode:'program',program:'node',args:['-e',"process.stdout.write('stdout-中文');process.stderr.write('warning')"],cwd:root},timeoutMs:30000};
 await call('foreground-1','exec_foreground',input);
 const fg=daemon.db.prepare("SELECT record_path,outcome,exit_code FROM activity WHERE id='foreground-1'").get();
 assert.ok(fg.record_path);assert.equal(fg.exit_code,0);
 assert.equal(daemon.journal.getRecordStream(fg.record_path,'stdout',0,65536).text,'stdout-中文');
 assert.equal(daemon.journal.getRecordStream(fg.record_path,'stderr',0,65536).text,'warning');
 assert.equal(daemon.journal.getResult(fg.record_path).result.stdout,'stdout-中文');
 const bin=join(root,'batch-read.txt');writeFileSync(bin,'batch content 123');
 await call('batch-1','batch',{deviceId:'test-device',description:'nested journal test',
  stages:[{parallel:false,failFast:true,calls:[{id:'read',tool:'fs_read',input:{path:bin}}]}],maxResultBytes:4096});
 const br=daemon.db.prepare("SELECT record_path FROM activity WHERE id='batch-1'").get();
 assert.ok(br.record_path);
 const child=recordRelativePath('batch-1:read');
 assert.ok(existsSync(daemon.journal.path(child)),'nested call gets its own JSONL');
 assert.equal(daemon.journal.getResult(child).result.content,'batch content 123');
 const bgInput={description:'async output',command:{mode:'program',program:'node',args:['-e',"setTimeout(()=>{process.stdout.write('async-ready');},120)"],cwd:root},terminal:'pipe'};
 await call('background-1','exec_background',bgInput);
 const deadline=Date.now()+12000;
 while(Date.now()<deadline){
  const bg=daemon.db.prepare("SELECT status FROM background WHERE id='background-1'").get();
  if(bg?.status==='exited')break;
  await new Promise(r=>setTimeout(r,50));
 }
 const bg=daemon.db.prepare("SELECT status,record_path FROM background WHERE id='background-1'").get();
 assert.equal(bg.status,'exited');assert.ok(bg.record_path);
 assert.equal(daemon.journal.getRecordStream(bg.record_path,'stdout',0,65536).text,'async-ready');
 const full=daemon.supervisor.output('background-1','stdout',0,100000);
 assert.equal(full.results[0].text,'async-ready');
 await call('background-fast','exec_background',{description:'fast process',command:{mode:'program',program:'node',args:['-e',"process.stdout.write('fast-exit')"],cwd:root},terminal:'pipe'});
 const fastDeadline=Date.now()+12000;
 while(Date.now()<fastDeadline){if(daemon.db.prepare("SELECT status FROM background WHERE id='background-fast'").get()?.status==='exited')break;await new Promise(r=>setTimeout(r,35));}
 const fast=daemon.db.prepare("SELECT record_path FROM background WHERE id='background-fast'").get();
 assert.ok(fast?.record_path);assert.equal(daemon.journal.getResult(fast.record_path)?.result.status,'running');
 assert.equal(daemon.journal.getRecordStream(fast.record_path,'stdout',0,65536).text,'fast-exit');
 assert.equal(existsSync(join(root,'output')),false);
 console.log('PASS actual foreground/background execution, event journal, batch subcalls and no output directory');
}finally{await daemon.shutdown();rmSync(root,{recursive:true,force:true});}
