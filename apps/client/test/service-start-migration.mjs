import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-required-migration-'));
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const env={...process.env,DESKBEACON_DATA_DIR:root,
 DESKBEACON_IPC_PATH:process.platform==='win32'?'\\\\.\\pipe\\deskbeacon-migrate-required-'+process.pid:join(root,'daemon.sock')};
writeFileSync(join(root,'config.json'),JSON.stringify({
 url:'http://127.0.0.1:9',deviceName:'migration-test',
 deviceId:'migration-test',clientId:'migration-test',accessToken:'test'
}));
const db=new DatabaseSync(join(root,'state.sqlite'));
db.exec('CREATE TABLE activity(id TEXT PRIMARY KEY,tool TEXT,description TEXT,status TEXT,time INTEGER,request_json TEXT,result TEXT)');
db.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY,status TEXT,created INTEGER,result TEXT)');
db.prepare('INSERT INTO activity(id,tool,description,status,time,request_json,result) VALUES(?,?,?,?,?,?,?)')
 .run('old-operation','fs_read','old operation','completed',Date.now()-10000,'{"path":"sample"}','{"content":"ok"}');
db.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,?)')
 .run('old-operation','completed',Date.now()-10000,'{"content":"ok"}');
db.close();
const run=(...args)=>spawnSync(process.execPath,[entry,...args],{env,encoding:'utf8',windowsHide:true,timeout:30000});
try{
 const start=run('service','start');
 assert.equal(start.status,0,start.stderr+'\n'+start.stdout);
 assert.match(start.stdout,/DeskBeacon 数据迁移/,'legacy database must show actual migration progress');
 assert.doesNotMatch(start.stdout,/正在检查本地存储版本/,'generic check message was removed');
 assert.doesNotMatch(start.stderr,/SQLite is an experimental feature/);
 const migrated=new DatabaseSync(join(root,'state.sqlite'),{readOnly:true});
 assert.equal(migrated.prepare("SELECT value FROM storage_metadata WHERE key='storage_version'").get().value,'0.2.0');
 const rec=migrated.prepare("SELECT record_path FROM activity WHERE id='old-operation'").get();
 assert.ok(rec?.record_path,'legacy activity must be migrated');
 migrated.close();
 const stop=run('service','stop');
 assert.equal(stop.status,0,stop.stderr+'\n'+stop.stdout);
 const restart=run('service','start');
 assert.equal(restart.status,0,restart.stderr+'\n'+restart.stdout);
 assert.doesNotMatch(restart.stdout,/DeskBeacon 数据迁移|正在检查本地存储版本/,'up-to-date version must start silently');
 assert.equal(run('service','stop').status,0);
 console.log('PASS genuine legacy DB upgrade reports progress once; subsequent start is silent');
}finally{
 try{run('service','stop');}catch{}
 rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}