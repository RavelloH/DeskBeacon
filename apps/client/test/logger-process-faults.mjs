import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readdirSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listJsonlFiles,readJsonl} from 'rlog-js';

const root=mkdtempSync(join(tmpdir(),'db-rlog-child-faults-'));
const fixture=fileURLToPath(new URL('./fixtures/logging-fault-worker.mjs',import.meta.url));
const run=(mode,extra={},timeoutMs=20000)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[fixture],{
  env:{...process.env,DESKBEACON_DATA_DIR:join(root,mode),
   DESKBEACON_LOG_TEST_MODE:mode,...extra},
  stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 let stdout='',stderr='',timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
 child.stdout.on('data',chunk=>stdout+=chunk.toString('utf8'));
 child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
 child.once('error',error=>{clearTimeout(timer);reject(error);});
 child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,timedOut});});
});
const collect=async(filePath,eventType)=>{
 const values=[];
 for await(const entry of readJsonl({filePath,eventTypes:[eventType]}))values.push(entry.record);
 return values;
};
try{
 // An uncaught exception must persist its fatal record and pre-crash breadcrumbs.
 // This child is completely separate from the live DeskBeacon service.
 const fatal=await run('fatal');
 assert.equal(fatal.code,1,'exception handler must exit nonzero: '+fatal.stderr);
 assert.equal(fatal.timedOut,false);
 const fatalDir=join(root,'fatal','logs');
 const fatalLog=await collect(join(fatalDir,'runtime.jsonl'),'process.uncaught_exception');
 assert.equal(fatalLog.length,1,'fatal event missing from persisted runtime log');
 assert.match(JSON.stringify(fatalLog),/SIMULATED_UNCAUGHT_FAILURE/);
 const exports=readdirSync(fatalDir).filter(file=>file.startsWith('flight-crash-'));
 assert.ok(exports.length>=2,'crash export must include runtime and connection domains');
 const exported=exports.map(file=>readFileSync(join(fatalDir,file),'utf8')).join('\n');
 assert.match(exported,/connection\.before_exit/);
 assert.match(exported,/process\.uncaught_exception/);
 assert.ok(!exported.includes('SECRET_TEST_TOKEN'),'crash export leaked a synthetic credential');

 // Force-killing a worker bypasses JS exception handlers, so no flight export
 // should be promised. The worker must first acknowledge that it initialized.
 const killed=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fixture],{
   env:{...process.env,DESKBEACON_DATA_DIR:join(root,'killed'),DESKBEACON_LOG_TEST_MODE:'killed'},
   stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  let stdout='',stderr='',signaled=false,timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},15000);
  child.stdout.on('data',chunk=>{
   stdout+=chunk.toString('utf8');
   if(stdout.includes('READY')&&!signaled){signaled=true;child.kill('SIGKILL');}
  });
  child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
  child.once('error',error=>{clearTimeout(timeout);reject(error);});
  child.once('close',(code,signal)=>{
   clearTimeout(timeout);resolve({code,signal,stderr,signaled,timedOut});
  });
 });
 assert.equal(killed.signaled,true,'forced kill fixture never reached the initialized state');
 assert.equal(killed.timedOut,false);
 assert.ok(killed.code!==0||killed.signal!==null,'forced kill unexpectedly exited cleanly');
 const killDir=join(root,'killed','logs');
 assert.ok(existsSync(killDir));
 assert.equal(readdirSync(killDir).filter(file=>file.startsWith('flight-crash-')).length,0,
  'forced kill unexpectedly generated a JS-based crash snapshot');

 // Three separate processes rotate aggressively. Isolated file mode prevents
 // their .1/.2 renames from conflicting; the reader must find every record.
 const sharedPath=join(root,'writers','multiprocess.jsonl');
 const writerIds=['one','two','three'];
 const writers=await Promise.all(writerIds.map(writer=>run('isolation',{
  DESKBEACON_LOG_TEST_FILE:sharedPath,DESKBEACON_LOG_TEST_WRITER:writer
 },30000)));
 for(let i=0;i<writers.length;i++){
  assert.equal(writers[i].timedOut,false);
  assert.equal(writers[i].code,0,'writer '+writerIds[i]+': '+writers[i].stderr);
 }
 const files=await listJsonlFiles(sharedPath);
 assert.ok(files.length>3,'rotations or instance file discovery failed');
 const streamNames=new Set(files.map(path=>{
  const name=basename(path);
  const match=/^multiprocess\.(\d+\.[a-f0-9]{32})\.jsonl(?:\.\d+)?$/.exec(name);
  assert.ok(match,'expected instance-isolated JSONL filename: '+name);
  return match[1];
 }));
 assert.equal(streamNames.size,3,'each child should have a distinct instance stream');
 const events=await collect(sharedPath,'multiprocess.record');
 assert.equal(events.length,360,'lost data during isolated multi-process rotation');
 const unique=new Set(events.map(event=>event.event.data.writer+':'+event.event.data.index));
 assert.equal(unique.size,360,'duplicated a record during concurrent rotation');
 for(const writer of writerIds)
  assert.equal(events.filter(event=>event.event.data.writer===writer).length,120);

 // A real Node subprocess experiences a filesystem open/write error and then
 // recovers after the output path becomes writable again.
 const file=join(root,'file-fault','writer.jsonl');
 const failure=await run('file-fault',{DESKBEACON_LOG_TEST_FILE:file});
 assert.equal(failure.code,0,'file fault/recovery fixture failed: '+failure.stderr);
 const report=JSON.parse(failure.stdout.trim());
 assert.ok(report.fileErrors>=1);
 assert.ok(report.recovery.successes>=1);
 assert.equal(report.sinkActive.jsonl,true);
 const restored=await collect(file,'file.recovered');
 assert.equal(restored.length,1,'recovered process could not persist to its restored file');

 console.log('PASS real subprocess uncaught failure, forced kill, isolated 3-writer rotation, file failure and recovery');
}finally{rmSync(root,{recursive:true,force:true});}
