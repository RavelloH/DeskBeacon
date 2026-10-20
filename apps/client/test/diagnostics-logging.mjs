import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-logs-test-'));
process.env.DESKBEACON_DATA_DIR=root;
const {logEvent,flushLogs,closeLogs,installDiagnostics,discardLegacyLog}=await import('../dist/diagnostics.js');
try{
 writeFileSync(join(root,'service.log'),'legacy');
 writeFileSync(join(root,'service.log.1'),'legacy');
 discardLegacyLog();
 assert.equal(existsSync(join(root,'service.log')),false);
 assert.equal(existsSync(join(root,'service.log.1')),false);
 logEvent('connection','websocket_closed','warn',{code:1006,reason:'Bearer VERY_SECRET'});
 logEvent('security','oauth.refresh_failed','error',{accessToken:'VERY_SECRET',reason:'authorization=SHOULD_HIDE'});
 logEvent('execution','foreground.completed_abnormally','error',{operationId:'123',exitCode:1});
 logEvent('migration','step.completed','info',{from:'0.1.0',to:'0.2.0'});
 logEvent('service','worker.spawned','info',{workerPid:1234});
 for(let i=0;i<600;i++)logEvent('connection','rotation.test','info',{id:i,details:'x'.repeat(5000)});
 await flushLogs();
 const directory=join(root,'logs'),names=readdirSync(directory);
 const expected=['connection','security','execution','migration','service'];
 for(const domain of expected){
  const f=join(directory,domain+'.jsonl');
  assert.ok(existsSync(f),domain+' logger did not write');
  const lines=readFileSync(f,'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length>0);
  for(const line of lines)assert.equal(JSON.parse(line).domain,domain);
 }
 assert.ok(names.some(n=>n.startsWith('connection.jsonl.')),'connection rotation should create an archive');
 assert.ok(names.filter(n=>n.startsWith('connection.jsonl')).length<=4,'connection logger keeps at most three archives');
 assert.ok(!readFileSync(join(directory,'security.jsonl'),'utf8').includes('VERY_SECRET'));
 assert.ok(!readFileSync(join(directory,'security.jsonl'),'utf8').includes('SHOULD_HIDE'));
 await closeLogs();
 const fatalDir=join(root,'fatal');
 const entry=new URL('../dist/diagnostics.js',import.meta.url);
 const script="process.env.DESKBEACON_DATA_DIR="+JSON.stringify(fatalDir)+
  ";const {installDiagnostics}=await import("+JSON.stringify(entry.href)+
  ");installDiagnostics('runtime');throw Error('intentional fatal test');";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,1,'fatal error must terminate child with error status');
 const crash=readFileSync(join(fatalDir,'logs','runtime.jsonl'),'utf8');
 assert.match(crash,/process.uncaught_exception/);
 assert.match(crash,/intentional fatal test/);
 assert.match(crash,/stack/);
 console.log('PASS six-domain structured RLog files, per-domain rotation, secret redaction, old-log cleanup and fatal crash diagnostics');
}finally{await closeLogs();rmSync(root,{recursive:true,force:true});}
