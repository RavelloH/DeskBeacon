import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'deskbeacon-cli-migrate-')),out=join(dir,'output');
mkdirSync(out);
const db=new DatabaseSync(join(dir,'state.sqlite'));
db.exec('CREATE TABLE activity(id TEXT PRIMARY KEY,tool TEXT,status TEXT,time INTEGER,request_json TEXT,result TEXT)');
db.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY,status TEXT,created INTEGER,result TEXT)');
db.exec('CREATE TABLE background(id TEXT PRIMARY KEY,operation_id TEXT,stdout_path TEXT,stderr_path TEXT,exit_code INTEGER,status TEXT)');
db.prepare('INSERT INTO activity(id,tool,status,time,request_json,result) VALUES(?,?,?,?,?,?)').run('old-cli','fs_read','completed',Date.now()-1000,'{"path":"test"}','{"content":"original"}');
db.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,?)').run('old-cli','completed',Date.now()-1000,'{"content":"original"}');
db.close();
writeFileSync(join(out,'old-cli.input.json'),'{"path":"test"}');
const bin=new URL('../dist/index.js',import.meta.url).pathname.replace(/^\/([A-Z]:\/)/,'$1');
const env={...process.env,DESKBEACON_DATA_DIR:dir,DESKBEACON_IPC_PATH:process.platform==='win32'
 ? '\\\\.\\pipe\\db-migrate-test-'+process.pid:join(dir,'isolated.sock')};
try{
 const command=spawnSync(process.execPath,[bin,'migrate','--no-tui'],{env,encoding:'utf8',timeout:20000,windowsHide:true});
 assert.equal(command.status,0,command.stderr||command.stdout);
 assert.ok(command.stdout.includes('数据迁移')&&command.stdout.includes('%'),command.stdout);
 assert.ok(command.stdout.includes('0.1.0')&&command.stdout.includes('0.2.0'));
 assert.equal(existsSync(out),false);
 const check=new DatabaseSync(join(dir,'state.sqlite'));
 assert.equal(check.prepare("SELECT value FROM storage_metadata WHERE key='storage_version'").get().value,'0.2.0');check.close();
 const again=spawnSync(process.execPath,[bin,'migrate','--no-tui'],{env,encoding:'utf8',timeout:20000,windowsHide:true});
 assert.equal(again.status,0,again.stderr);
 assert.ok(again.stdout.includes('已经是最新版本'));
 console.log('PASS real deskbeacon migrate --no-tui CLI, progress output, version ledger and no-op rerun');
}finally{rmSync(dir,{recursive:true,force:true});}
