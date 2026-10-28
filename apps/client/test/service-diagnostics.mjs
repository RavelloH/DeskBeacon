import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=mkdtempSync(join(tmpdir(),'db-runtime-logger-ipc-'));
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'?
 '\\\\.\\pipe\\deskbeacon-logger-diag-'+process.pid:join(root,'runtime.sock');
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const env={...process.env};
const {startIpc,closeIpc,requestIpc}=await import('../dist/ipc.js');
const {logEvent,flushLogs,closeLogs,diagnosticsSnapshot}=await import('../dist/diagnostics.js');

const runCli=(...args)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[entry,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 const timeout=setTimeout(()=>child.kill('SIGKILL'),12000);
 child.stdout.on('data',buffer=>stdout+=buffer.toString('utf8'));
 child.stderr.on('data',buffer=>stderr+=buffer.toString('utf8'));
 child.once('error',error=>{clearTimeout(timeout);reject(error);});
 child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal,stdout,stderr});});
});
let server;
try{
 logEvent('runtime','runtime.diag_test','info',{});
 logEvent('connection','connection.debug_breadcrumb','debug',{step:1,authorization:'Bearer VERY_SECRET'});
 await flushLogs();
 const daemon=new EventEmitter();
 server=startIpc(daemon);
 if(!server.listening)await once(server,'listening');
 const result=await requestIpc({action:'diagnostics'});
 assert.equal(result.scope,'runtime');
 assert.equal(result.schemaVersion,1);
 assert.equal(result.pid,process.pid);
 assert.ok(result.capturedAt);
 assert.ok(result.uptimeSeconds>=0);
 assert.ok(result.memoryRssBytes>0);
 assert.ok(result.loggers.runtime);
 assert.ok(result.loggers.connection);
 assert.equal(result.loggers.connection.logger.maxQueuedRecords,1024);
 assert.equal(result.loggers.connection.flightRecorder.enabled,true);
 assert.equal(result.loggers.connection.flightRecorder.records,1);
 assert.deepEqual(Object.keys(result.loggers).sort(),Object.keys(diagnosticsSnapshot()).sort());
 assert.ok(!JSON.stringify(result).includes('VERY_SECRET'),'IPC must not include Flight Recorder record data');

 const pretty=await runCli('service','diagnostics');
 assert.equal(pretty.code,0,pretty.stderr);
 assert.match(pretty.stdout,/Runtime diagnostics/);
 assert.match(pretty.stdout,/Runtime only/);
 assert.match(pretty.stdout,/connection: sink=active/);
 assert.match(pretty.stdout,/queue=/);
 assert.match(pretty.stdout,/flight=/);
 assert.ok(!pretty.stdout.includes('VERY_SECRET'));

 const json=await runCli('service','diagnostics','--json');
 assert.equal(json.code,0,json.stderr);
 const parsed=JSON.parse(json.stdout);
 assert.equal(parsed.scope,'service');
 assert.equal(parsed.runtimeStatus,'connected');
 assert.equal(parsed.supervisor,null);
 assert.equal(parsed.runtime.scope,'runtime');
 assert.equal(parsed.runtime.pid,process.pid);
 assert.equal(parsed.runtime.loggers.connection.logger.maxQueuedBytes,1024*1024);

 const bad=await runCli('service','diagnostics','--unknown');
 assert.equal(bad.code,1);
 assert.match(bad.stderr,/Usage: deskbeacon service diagnostics/);
 await closeIpc(server);server=null;
 const unavailable=await runCli('service','diagnostics');
 assert.equal(unavailable.code,1);
 assert.match(unavailable.stderr,/Cannot query Runtime diagnostics via IPC/);
 console.log('PASS Runtime IPC diagnostics, safe JSON/human output, invalid flag and offline failure');
}finally{
 if(server)await closeIpc(server);
 await closeLogs();
 rmSync(root,{recursive:true,force:true});
}
