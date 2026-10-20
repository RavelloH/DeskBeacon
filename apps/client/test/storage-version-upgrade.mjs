import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runStorageMigrations,storedVersion,migrationRequired} from '../dist/storage-migrations.js';
import {RecordJournal} from '../dist/record-journal.js';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-version-migrate-')),output=join(root,'output');
mkdirSync(output);
const db=new DatabaseSync(join(root,'state.sqlite'));
db.exec('CREATE TABLE activity(id TEXT PRIMARY KEY,grant_id TEXT,tool TEXT,description TEXT,status TEXT,time INTEGER,result TEXT,request_json TEXT)');
db.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY,status TEXT,created INTEGER,result TEXT)');
db.exec('CREATE TABLE background(id TEXT PRIMARY KEY,operation_id TEXT,description TEXT,pid INTEGER,status TEXT,start INTEGER,exit_code INTEGER,stdout_path TEXT,stderr_path TEXT)');
const at=Date.now()-60_000,id='legacy-test';
db.prepare('INSERT INTO activity(id,tool,status,time,request_json,result) VALUES(?,?,?,?,?,?)')
 .run(id,'exec_foreground','completed',at,JSON.stringify({command:{script:'echo migration'}}),JSON.stringify({exitCode:0}));
db.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,?)')
 .run(id,'completed',at,JSON.stringify({exitCode:0,stdout:'before migration',stderr:''}));
db.close();
writeFileSync(join(output,id+'.input.json'),JSON.stringify({command:{script:'echo migration'}}));
writeFileSync(join(output,id+'.out'),'before migration');
writeFileSync(join(output,id+'.err'),'');
writeFileSync(join(output,'unlinked-legacy.out'),'preserve orphan output');
try{
 assert.equal(migrationRequired(root,'0.2.0'),true);
 const seen=[];const outcome=await runStorageMigrations({root,target:'0.2.0',onProgress:p=>seen.push(p)});
 assert.deepEqual(outcome.steps,['0.2.0']);
 assert.equal(outcome.from,'0.1.0');assert.equal(outcome.to,'0.2.0');
 assert.equal(outcome.removedOldOutput,true);assert.equal(existsSync(output),false);
 assert.ok(seen.length>1);assert.ok(seen.every((p,i)=>i===0||p.percent>=seen[i-1].percent),'percentage must never go backwards');
 assert.equal(seen.at(-1).percent,100);
 const upgraded=new DatabaseSync(join(root,'state.sqlite'));
 assert.equal(storedVersion(upgraded),'0.2.0');
 const row=upgraded.prepare('SELECT record_path,request_json,result FROM activity WHERE id=?').get(id);
 assert.ok(row.record_path);assert.equal(row.request_json,null);assert.equal(row.result,null);
 const orphan=upgraded.prepare("SELECT record_path FROM activity WHERE tool='legacy_orphan'").get();
 assert.ok(orphan?.record_path);
 const journal=new RecordJournal(join(root,'records'));
 assert.equal(journal.getRecordStream(row.record_path,'stdout',0,65536).text,'before migration');
 assert.equal(journal.getRecordStream(orphan.record_path,'stdout',0,65536).text,'preserve orphan output');
 const expected=upgraded.prepare('SELECT count(*) n FROM activity').get().n;
 upgraded.close();
 const rerun=await runStorageMigrations({root,target:'0.2.0'});
 assert.equal(rerun.changed,false);assert.equal(rerun.steps.length,0);
 const check=new DatabaseSync(join(root,'state.sqlite'));
 assert.equal(check.prepare('SELECT count(*) n FROM activity').get().n,expected);
 assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');check.close();
 console.log('PASS foreground blocking migration, semver ledger, monotonic progress, output cleanup, orphan preservation and idempotence');
}finally{rmSync(root,{recursive:true,force:true});}
