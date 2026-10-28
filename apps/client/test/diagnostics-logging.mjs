import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {listJsonlFiles,readJsonl} from 'rlog-js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-logs-test-'));
process.env.DESKBEACON_DATA_DIR=root;
const {
 logEvent,flushLogs,closeLogs,installDiagnostics,discardLegacyLog,
 diagnosticsSnapshot,getFlightRecorderSnapshot,withLogContext,
 readDiagnosticLogTail
}=await import('../dist/diagnostics.js');
const cli=new URL('../dist/index.js',import.meta.url);
const readEvents=async(filePath,eventType)=>{
 const found=[];
 for await(const item of readJsonl({filePath,eventTypes:[eventType],skipMalformed:false}))found.push(item);
 return found;
};
try{
 writeFileSync(join(root,'service.log'),'legacy');
 writeFileSync(join(root,'service.log.1'),'legacy');
 discardLegacyLog();
 assert.equal(existsSync(join(root,'service.log')),false);
 assert.equal(existsSync(join(root,'service.log.1')),false);

 logEvent('connection','websocket_closed','warn',{code:1006,reason:'Bearer VERY_SECRET'});
 logEvent('security','oauth.refresh_failed','error',{accessToken:'VERY_SECRET',reason:'authorization=SHOULD_HIDE'});
 const oversizedDetails=Object.fromEntries(Array.from({length:5000},(_,i)=>['field'+i,'value']));
 logEvent('security','sanitizer.bounded','info',oversizedDetails);
 logEvent('execution','foreground.completed_abnormally','error',{operationId:'123',exitCode:1});
 logEvent('migration','step.completed','info',{from:'old',to:'current'});
 logEvent('service','worker.spawned','info',{workerPid:1234});

 await withLogContext('execution',{operationId:'ctx-42',executionMode:'foreground'},async()=>{
  await delay(5);
  logEvent('execution','context.propagated','info',{marker:'CTX_OK'});
 });
 await flushLogs();
 const contextEvents=await readEvents(join(root,'logs','execution.jsonl'),'context.propagated');
 assert.equal(contextEvents.length,1);
 assert.equal(contextEvents[0].record.context.operationId,'ctx-42');
 assert.equal(contextEvents[0].record.context.executionMode,'foreground');

 logEvent('connection','connection.breadcrumb','debug',{attempt:3,authorization:'Bearer VERY_SECRET'});
 const breadcrumb=getFlightRecorderSnapshot('connection');
 assert.ok(breadcrumb.some(record=>record.event?.type==='connection.breadcrumb'),'debug event was not captured by Flight Recorder');
 assert.ok(!JSON.stringify(breadcrumb).includes('VERY_SECRET'),'Flight Recorder leaked a bearer token');
 assert.ok(JSON.stringify(breadcrumb).toLowerCase().includes('[redacted]'),'Flight Recorder lost the redaction marker');
 const initialDiagnostics=diagnosticsSnapshot().connection;
 assert.ok(initialDiagnostics);
 assert.equal(initialDiagnostics.logger.maxQueuedRecords,1024);
 assert.equal(initialDiagnostics.logger.maxQueuedBytes,1024*1024);
 assert.equal(initialDiagnostics.logger.maxRecordBytes,64*1024);
 assert.equal(initialDiagnostics.flightRecorder.enabled,true);

 // Flush periodically so the test exercises rotation without intentionally
 // overflowing the high-severity queue.
 for(let i=0;i<600;i++){
  logEvent('connection','rotation.test','info',{id:i,details:'x'.repeat(5000)});
  if(i%50===49)await flushLogs();
 }
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
 const files=await listJsonlFiles(join(directory,'connection.jsonl'));
 assert.ok(files.length>1,'RLog did not discover rotated files');
 const rotations=await readEvents(join(directory,'connection.jsonl'),'rotation.test');
 assert.equal(rotations.length,600,'RLog reader did not read every retained rotated record');
 assert.equal(rotations[0].record.event.data.id,0);
 assert.equal(rotations.at(-1).record.event.data.id,599);
 assert.equal((await readEvents(join(directory,'connection.jsonl'),'connection.breadcrumb')).length,0,
  'debug breadcrumb unexpectedly leaked into persistent info-level JSONL');
 assert.ok(!readFileSync(join(directory,'security.jsonl'),'utf8').includes('VERY_SECRET'));
 assert.ok(!readFileSync(join(directory,'security.jsonl'),'utf8').includes('SHOULD_HIDE'));
 const boundedEvents=await readEvents(join(directory,'security.jsonl'),'sanitizer.bounded');
 assert.equal(boundedEvents.length,1);
 assert.equal(Object.keys(boundedEvents[0].record.event.data).length,41);
 assert.equal(boundedEvents[0].record.event.data.__truncated__,true);

 // Verify the CLI now includes rotated records rather than reading only the
 // active file. The archived marker is deliberately absent from the active log.
 logEvent('runtime','runtime.active_marker','info',{marker:'ACTIVE_MARKER'});
 await flushLogs();
 const runtimePath=join(directory,'runtime.jsonl');
 const archived={
  schema:'rlog.record',version:1,domain:'runtime',pid:4321,
  timestamp:new Date(Date.now()-1000).toISOString(),level:'info',message:'runtime.archive_marker',
  args:['runtime.archive_marker'],context:{},meta:{},
  event:{type:'runtime.archive_marker',data:{marker:'ARCHIVE_ONLY_MARKER'}}
 };
 writeFileSync(runtimePath+'.1',JSON.stringify(archived)+'\n');
 // Two instance writers may be discovered in filename order unrelated to
 // their timestamps. The CLI tail must display chronological order instead.
 const isolated=(pid,nonce,marker,offset)=>{
  const record={...archived,timestamp:new Date(Date.now()+offset).toISOString(),
   message:marker,event:{type:'runtime.cross_instance_test',data:{marker}}};
  writeFileSync(join(directory,'runtime.'+pid+'.'+nonce+'.jsonl'),JSON.stringify(record)+'\n');
 };
 isolated(111,'a'.repeat(32),'LATEST_INSTANCE',15000);
 isolated(222,'b'.repeat(32),'OLDER_INSTANCE',-15000);
 const logCommand=spawnSync(process.execPath,[fileURLToPath(cli),'service','logs','runtime'],{
  encoding:'utf8',timeout:12000,windowsHide:true,
  env:{...process.env,DESKBEACON_DATA_DIR:root}
 });
 assert.equal(logCommand.status,0,'service logs failed: '+logCommand.stderr);
 assert.ok(logCommand.stdout.includes('ARCHIVE_ONLY_MARKER'),'service logs omitted rotated history');
 assert.ok(logCommand.stdout.includes('ACTIVE_MARKER'),'service logs omitted the active file');
 const tail=await readDiagnosticLogTail('runtime',4096);
 assert.ok(tail.includes('ARCHIVE_ONLY_MARKER')&&tail.includes('ACTIVE_MARKER'));
 assert.ok(tail.indexOf('OLDER_INSTANCE')<tail.indexOf('LATEST_INSTANCE'),
  'tail must order independent writer streams by their timestamps');
 assert.ok(tail.trimEnd().endsWith('}')&&tail.includes('LATEST_INSTANCE'),
  'timestamp-sorted tail did not preserve the latest instance record');

 // A burst of low-priority diagnostics must be bounded and may be dropped
 // without sacrificing warning/error records.
 for(let i=0;i<3000;i++)logEvent('connection','queue.burst','debug',{index:i,payload:'x'.repeat(512)});
 await flushLogs();
 const afterBurst=diagnosticsSnapshot().connection;
 assert.ok(afterBurst.logger.droppedRecords>0,'queue overflow did not drop low-priority debug records');
 assert.ok(afterBurst.flightRecorder.records<=128,'Flight Recorder exceeded its record budget');
 assert.ok(afterBurst.flightRecorder.bytes<=128*1024,'Flight Recorder exceeded its byte budget');

 // Simulate a file path temporarily becoming unusable, then verify that RLog
 // reopens it opportunistically after the configured backoff.
 const tuiPath=join(directory,'tui.jsonl');
 mkdirSync(tuiPath);
 const originalStderrWrite=process.stderr.write.bind(process.stderr);
 let expectedFileErrorLogged=false;
 process.stderr.write=(chunk,...args)=>{
  const text=typeof chunk==='string'?chunk:Buffer.isBuffer(chunk)?chunk.toString('utf8'):'';
  if(text.includes('[DeskBeacon log failure]')&&text.includes('tui.jsonl')&&text.includes('EISDIR')){
   expectedFileErrorLogged=true;
   return true;
  }
  return originalStderrWrite(chunk,...args);
 };
 try{
  logEvent('tui','recovery.first_failure','warn',{marker:'first'});
  await flushLogs();
 }finally{process.stderr.write=originalStderrWrite;}
 assert.ok(expectedFileErrorLogged,'file error callback did not report the injected failure');
 assert.ok((diagnosticsSnapshot().tui?.logger.fileErrors??0)>0,'file failure was not diagnosed');
 rmSync(tuiPath,{recursive:true,force:true});
 await delay(1150);
 logEvent('tui','recovery.after_reopen','info',{marker:'RECOVERED'});
 await flushLogs();
 assert.ok(existsSync(tuiPath),'RLog did not recreate the failed JSONL sink');
 assert.ok(readFileSync(tuiPath,'utf8').includes('recovery.after_reopen'),'recovered sink did not persist the next record');
 assert.equal(diagnosticsSnapshot().tui?.logger.sinkActive.jsonl,true);

 await closeLogs();

 const fatalDir=join(root,'fatal');
 const diagnosticsUrl=new URL('../dist/diagnostics.js',import.meta.url);
 const script='process.env.DESKBEACON_DATA_DIR='+JSON.stringify(fatalDir)+
  ';const {installDiagnostics,logEvent}=await import('+JSON.stringify(diagnosticsUrl.href)+
  ');installDiagnostics("runtime");logEvent("connection","connection.before_crash","debug",{attempt:4,authorization:"Bearer VERY_SECRET"});throw Error("intentional fatal test");';
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,1,'fatal error must terminate child with error status');
 const crash=readFileSync(join(fatalDir,'logs','runtime.jsonl'),'utf8');
 assert.match(crash,/process.uncaught_exception/);
 assert.match(crash,/intentional fatal test/);
 assert.match(crash,/stack/);
 const snapshots=readdirSync(join(fatalDir,'logs')).filter(name=>name.startsWith('flight-crash-'));
 assert.ok(snapshots.length>=2,'fatal process did not export per-domain Flight Recorder snapshots');
 const snapshotText=snapshots.map(name=>readFileSync(join(fatalDir,'logs',name),'utf8')).join('\n');
 assert.match(snapshotText,/process\.uncaught_exception/,'crash snapshot omitted fatal context');
 assert.match(snapshotText,/connection\.before_crash/,'crash snapshot omitted pre-crash breadcrumb');
 assert.ok(!snapshotText.includes('VERY_SECRET'),'crash snapshot leaked a bearer token');
 console.log('PASS RLog 3.1 budgets, async context, bounded Flight Recorder, crash export, file recovery, rotated JSONL reader and CLI logs');
}finally{await closeLogs();rmSync(root,{recursive:true,force:true});}
