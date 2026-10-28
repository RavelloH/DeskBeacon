import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,utimesSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const root=mkdtempSync(join(tmpdir(),'db-supervisor-diagnostics-'));
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'?
 '\\\\.\\pipe\\db-supervisor-diag-'+process.pid:join(root,'runtime.sock');
const env={...process.env};
const workerEntry=fileURLToPath(new URL('./fixtures/supervisor-restart-worker.mjs',import.meta.url));
const cliEntry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const {pruneCrashSnapshots,snapshotRetention}=await import('../dist/diagnostic-retention.js');
const {readSupervisorReport}=await import('../dist/supervisor-diagnostics.js');
const {logsDir}=await import('../dist/diagnostics-paths.js');

const runCli=(...args)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[cliEntry,...args],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='';
 const timer=setTimeout(()=>child.kill('SIGKILL'),12000);
 child.stdout.on('data',buffer=>stdout+=buffer.toString());
 child.stderr.on('data',buffer=>stderr+=buffer.toString());
 child.once('error',error=>{clearTimeout(timer);reject(error);});
 child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
});
async function poll(predicate,timeout=11000){
 const started=Date.now();
 while(Date.now()-started<timeout){
  const value=predicate();
  if(value)return value;
  await sleep(40);
 }
 throw Error('SUPERVISOR_DIAGNOSTIC_TIMEOUT');
}
let supervisor;
try{
 // Retention only applies to our exact crash-export naming pattern.
 const owned=(n,size=160*1024,expired=false)=>{
  const path=join(logsDir,'flight-test'+n+'-123-2026-10-27T03-04-05-006Z-runtime.jsonl');
  writeFileSync(path,Buffer.alloc(size,88));
  if(expired){
   const old=new Date(Date.now()-25*24*60*60*1000);
   utimesSync(path,old,old);
  }
  return path;
 };
 const {mkdirSync}=await import('node:fs');
 mkdirSync(logsDir,{recursive:true});
 writeFileSync(join(logsDir,'user-document.txt'),'preserve');
 writeFileSync(join(logsDir,'flight-invalid.jsonl'),'preserve');
 const retained=owned(0,2000,true);
 for(let i=1;i<45;i++)owned(i,160*1024,i===1);
 let prune=pruneCrashSnapshots([retained]);
 assert.equal(prune.inspected,45);
 assert.ok(prune.remaining<=snapshotRetention.maxFiles);
 assert.ok(prune.remainingBytes<=snapshotRetention.maxBytes);
 assert.equal(existsSync(retained),true,'current-export file must be preserved');
 assert.equal(existsSync(join(logsDir,'user-document.txt')),true);
 assert.equal(readFileSync(join(logsDir,'flight-invalid.jsonl'),'utf8'),'preserve');
 pruneCrashSnapshots();
 assert.equal(existsSync(retained),false,'expired crash file should be removed');

 // Byte budget is global across all crash reports, including older instances.
 for(let i=50;i<82;i++)owned(i,512*1024);
 prune=pruneCrashSnapshots();
 assert.ok(prune.remainingBytes<=snapshotRetention.maxBytes);
 assert.ok(prune.remaining<=snapshotRetention.maxFiles);
 assert.equal(existsSync(join(logsDir,'user-document.txt')),true);

 // Run an actual Supervisor with a worker that fails repeatedly.
 // All paths and IPC are isolated from the user's running service.
 const entryUrl=new URL('../dist/service-supervisor.js',import.meta.url).href;
 const code='const {superviseService}=await import('+JSON.stringify(entryUrl)+');'+
  'await superviseService({workerEntry:'+JSON.stringify(workerEntry)+',workerArgs:[],restartDelayMs:120});';
 supervisor=spawn(process.execPath,['--input-type=module','-e',code],{
  env,stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 let stderr='';
 supervisor.stderr.on('data',chunk=>stderr+=chunk.toString());
 const active=await poll(()=>{
  const report=readSupervisorReport();
  return report?.running && report.totalRestarts>=1 && report.lastExit?.code===17 ? report:null;
 });
 assert.equal(active.scope,'supervisor');
 assert.ok(active.fresh,'Supervisor report must be fresh while heartbeats are arriving');
 assert.ok(active.logger);
 assert.equal(active.logger.fileErrors,0);
 assert.ok(active.totalRestarts>=1);
 assert.equal(active.lastExit.code,17);

 const online=await runCli('service','diagnostics','--json');
 assert.equal(online.code,0,'CLI failed: '+online.stderr);
 const json=JSON.parse(online.stdout);
 assert.equal(json.scope,'service');
 assert.equal(json.runtime,null,'Runtime should not exist in isolated supervisor test');
 assert.equal(json.runtimeStatus,'unavailable');
 assert.equal(json.supervisor.running,true);
 assert.ok(json.supervisor.totalRestarts>=1);
 assert.ok(!JSON.stringify(json).includes('SECRET_TEST_TOKEN'));
 const pretty=await runCli('service','diagnostics');
 assert.equal(pretty.code,0,pretty.stderr);
 assert.match(pretty.stdout,/Supervisor:/);
 assert.match(pretty.stdout,/Last worker exit: code=17/);
 assert.match(pretty.stdout,/Runtime: unavailable/);

 writeFileSync(join(root,'supervisor.stop'),JSON.stringify({requestedAt:Date.now()}));
 const exit=await Promise.race([
  new Promise(resolve=>supervisor.once('close',(code,signal)=>resolve({code,signal}))),
  sleep(10000).then(()=>({timedOut:true}))
 ]);
 assert.equal(exit.timedOut,undefined,'Supervisor failed to stop: '+stderr);
 supervisor=null;
 const stopped=readSupervisorReport();
 assert.ok(stopped);
 assert.equal(stopped.running,false,'snapshot must not claim an absent process is alive');
 assert.equal(stopped.phase,'stopped');
 const after=await runCli('service','diagnostics','--json');
 assert.equal(after.code,0,after.stderr);
 assert.equal(JSON.parse(after.stdout).supervisor.running,false);

 // The terminal reason must not be overwritten by the finally block once
 // the restart limit is exceeded. Use a separate isolated Supervisor.
 const limitDir=join(root,'limit');
 const limitChild=spawn(process.execPath,['--input-type=module','-e',
  'const {superviseService}=await import('+JSON.stringify(entryUrl)+');'+
  'await superviseService({workerEntry:'+JSON.stringify(workerEntry)+',workerArgs:[],restartDelayMs:20});'],{
   env:{...env,DESKBEACON_DATA_DIR:limitDir},stdio:['ignore','pipe','pipe'],windowsHide:true
  });
 let limitStderr='';
 limitChild.stderr.on('data',chunk=>limitStderr+=chunk.toString());
 const limitExited=await Promise.race([
  new Promise(resolve=>limitChild.once('close',(code,signal)=>resolve({code,signal}))),
  sleep(14000).then(()=>({timedOut:true}))
 ]);
 if(limitExited.timedOut)limitChild.kill('SIGKILL');
 assert.equal(limitExited.timedOut,undefined,'restart-limit fixture timed out: '+limitStderr);
 const finalReport=JSON.parse(readFileSync(join(limitDir,'supervisor-diagnostics.json'),'utf8'));
 assert.equal(finalReport.phase,'restart-limit');
 assert.equal(finalReport.totalRestarts,9);
 assert.equal(finalReport.lastExit.code,17);
 console.log('PASS snapshot retention, Supervisor restart telemetry, CLI fallback, stale status and terminal restart-limit');
}finally{
 if(supervisor){try{supervisor.kill('SIGKILL');}catch{}}
 rmSync(root,{recursive:true,force:true});
}
