import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-dispatch-v2-'));
process.env.DESKBEACON_DATA_DIR=root;
const {ClientDaemon}=await import('../dist/daemon.js');
const daemon=new ClientDaemon({url:'https://example.invalid',deviceId:'test-device',accessToken:'TEST_ACCESS',clientId:'TEST_CLIENT',deviceName:'Test'});
const sent=[];
daemon.send=function(value){sent.push(value);return 'test-message-'+sent.length;};
daemon.sendSafe=async function(value){sent.push(value);return 'test-message-'+sent.length;};
const call=async(id,tool,input)=>{
 const requestHash=createHash('sha256').update(JSON.stringify([tool,input])).digest('hex');
 await daemon.dispatch({type:'operation.dispatch',operationId:id,toolName:tool,input,requestHash,expiresAt:new Date(Date.now()+120000).toISOString(),grantId:'grant-test',actorName:'Test Agent'});
};
try{
 const target=join(root,'once.txt');
 await call('once-file','fs_write',{path:target,mode:'create',content:'only once'});
 const row=daemon.db.prepare("SELECT record_path,request_json,result,outcome FROM activity WHERE id='once-file'").get();
 assert.ok(row.record_path);assert.equal(row.request_json,null);assert.equal(row.result,null);
 assert.equal(row.outcome,'success');
 assert.equal(daemon.db.prepare("SELECT result FROM receipts WHERE id='once-file'").get().result,null);
 assert.deepEqual(daemon.journal.getInput(row.record_path).path,target);
 assert.equal(daemon.journal.getResult(row.record_path).result.writtenBytes,9);
 assert.ok(existsSync(target));
 assert.equal(existsSync(join(root,'output')),false,'new operations must not create legacy output dir');
 const existing=sent.length;
 await call('once-file','fs_write',{path:target,mode:'create',content:'only once'});
 assert.ok(sent.length>existing,'duplicate dispatch must replay rather than execute again');
 const page=daemon.activityList({limit:50});
 assert.equal(page.rows[0].request_json!==null,true);
 assert.match(page.rows[0].result,/writtenBytes/);
 const matches=await daemon.activitySearch({query:'only once',limit:50});
 assert.equal(matches.total,1,'on-demand rg must find command contents absent from SQLite');
 assert.equal(daemon.db.prepare('SELECT count(*) n FROM unacked_results').get().n,1);
 console.log('PASS new device dispatch, meta-only SQLite, journal replay and UI hydration');
}finally{await daemon.shutdown();rmSync(root,{recursive:true,force:true});}
