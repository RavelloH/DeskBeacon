import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-startup-gate-'));
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'
 ? '\\\\.\\pipe\\deskbeacon-gate-'+process.pid:join(root,'daemon.sock');
const out=join(root,'output');mkdirSync(out);writeFileSync(join(out,'legacy.input.json'),'{"path":"old"}');
const pre=new DatabaseSync(join(root,'state.sqlite'));
pre.exec('CREATE TABLE activity(id TEXT PRIMARY KEY,grant_id TEXT,tool TEXT,description TEXT,status TEXT,time INTEGER,result TEXT,request_json TEXT)');
pre.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY,status TEXT,created INTEGER,result TEXT)');
pre.prepare('INSERT INTO activity(id,tool,description,status,time,result,request_json) VALUES(?,?,?,?,?,?,?)')
 .run('legacy','fs_read','legacy read','completed',Date.now()-1000,'{"content":"old result"}','{"path":"old"}');
pre.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,?)')
 .run('legacy','completed',Date.now()-1000,'{"content":"old result"}');
pre.close();
const {ClientDaemon}=await import('../dist/daemon.js');
const {startIpc}=await import('../dist/ipc.js');
const {runStorageMigrations,migrationRequired}=await import('../dist/storage-migrations.js');
const config={url:'https://example.invalid',deviceId:'fixture',clientId:'fixture',accessToken:'test',deviceName:'Test'};
try{
 assert.equal(migrationRequired(root),true);
 const daemon=new ClientDaemon(config),listener=startIpc(daemon);
 try{
  await new Promise(resolve=>listener.once('listening',resolve));
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(daemon.db.prepare("SELECT record_path FROM activity WHERE id='legacy'").get().record_path,null,
   'IPC must not trigger background migration');
  assert.equal(existsSync(out),true);
 }finally{await new Promise(resolve=>listener.close(resolve));await daemon.shutdown();}
 const outcome=await runStorageMigrations({root});
 assert.equal(outcome.to,'0.2.0');assert.equal(outcome.removedOldOutput,true);
 assert.equal(migrationRequired(root),false);
 const reopened=new ClientDaemon(config);
 try{
  const row=reopened.db.prepare("SELECT record_path,result FROM activity WHERE id='legacy'").get();
  assert.ok(row.record_path);assert.equal(row.result,null);
  assert.equal(reopened.journal.getResult(row.record_path).result.content,'old result');
 }finally{await reopened.shutdown();}
 console.log('PASS IPC startup never migrates in background; standalone foreground upgrade gates Runtime');
}finally{rmSync(root,{recursive:true,force:true});}
