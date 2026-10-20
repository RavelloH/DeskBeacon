import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-crash-v2-'));
process.env.DESKBEACON_DATA_DIR=root;
const {ClientDaemon}=await import('../dist/daemon.js');
const config={url:'https://example.invalid',deviceId:'crash-device',accessToken:'test',clientId:'test',deviceName:'Test'};
const tool='fs_write',id='crash-operation',target=join(root,'once.txt'),input={path:target,mode:'create',content:'exactly once'};
const message={type:'operation.dispatch',operationId:id,toolName:tool,input,
 requestHash:createHash('sha256').update(JSON.stringify([tool,input])).digest('hex'),
 expiresAt:new Date(Date.now()+300_000).toISOString(),grantId:'test',actorName:'Test'};
let daemon=new ClientDaemon(config);
try{
 daemon.send=()=> 'fake';daemon.sendSafe=async()=> 'fake';
 await daemon.dispatch(message);
 assert.equal(daemon.db.prepare('SELECT status FROM receipts WHERE id=?').get(id).status,'completed');
 // Simulate SIGKILL after journal fsync but before SQLite final receipt + ACK.
 daemon.db.prepare("UPDATE receipts SET status='accepted' WHERE id=?").run(id);
 daemon.db.prepare("UPDATE activity SET status='running',outcome='running' WHERE id=?").run(id);
 daemon.db.prepare('DELETE FROM unacked_results WHERE operation_id=?').run(id);
 await daemon.shutdown();
 daemon=new ClientDaemon(config);
 const row=daemon.db.prepare('SELECT status,outcome FROM activity WHERE id=?').get(id);
 assert.equal(row.status,'completed');assert.equal(row.outcome,'success');
 assert.equal(daemon.db.prepare('SELECT status FROM receipts WHERE id=?').get(id).status,'completed');
 assert.equal(daemon.db.prepare('SELECT count(*) n FROM unacked_results WHERE operation_id=?').get(id).n,1);
 const sent=[];daemon.send=value=>(sent.push(value),'fake');daemon.sendSafe=async value=>(sent.push(value),'fake');
 await daemon.dispatch(message);
 assert.equal(readFileSync(target,'utf8'),'exactly once');
 assert.ok(sent.some(v=>v.type==='operation.result.commit'),'idempotent result must replay');
 console.log('PASS recovery from journal-completed / SQLite-accepted crash window, exactly-once file creation');
}finally{await daemon.shutdown();rmSync(root,{recursive:true,force:true});}
