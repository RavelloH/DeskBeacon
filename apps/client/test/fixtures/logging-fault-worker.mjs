import Rlog from 'rlog-js';
import {mkdirSync,rmSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';

const mode=process.env.DESKBEACON_LOG_TEST_MODE;
if(mode==='fatal'||mode==='killed'){
 const {installDiagnostics,logEvent,flushLogs}=await import('../../dist/diagnostics.js');
 installDiagnostics('runtime');
 logEvent('connection','connection.before_exit','debug',{
  simulated:true,kind:mode,authorization:'Bearer SECRET_TEST_TOKEN'
 });
 if(mode==='fatal'){
  await sleep(20);
  throw new Error('SIMULATED_UNCAUGHT_FAILURE');
 }
 await flushLogs();
 process.stdout.write('READY\n');
 setInterval(()=>{},1000);
}else if(mode==='isolation'){
 const writer=process.env.DESKBEACON_LOG_TEST_WRITER??'unknown';
 const logger=new Rlog({
  jsonlFilePath:process.env.DESKBEACON_LOG_TEST_FILE,
  screenOutput:'none',jsonlLogLevel:'info',
  jsonlFileIsolation:'instance',
  jsonlRotation:{maxBytes:4096,maxFiles:20},
  maxQueuedRecords:512,maxQueuedBytes:1024*1024,
 });
 for(let i=0;i<120;i++){
  logger.jsonl.event('multiprocess.record',{writer,index:i,payload:'x'.repeat(140)},{level:'info'});
  if(i%25===24)await logger.flush();
 }
 await logger.syncFiles();
 await logger.close();
 process.stdout.write('DONE '+writer+'\n');
}else if(mode==='file-fault'){
 const file=process.env.DESKBEACON_LOG_TEST_FILE;
 mkdirSync(file,{recursive:true});
 const logger=new Rlog({
  jsonlFilePath:file,
  jsonlLogLevel:'info',screenOutput:'none',
  fileErrorPolicy:'disable',
  autoRecoverFiles:{initialDelayMs:30,maxDelayMs:100,multiplier:2},
 });
 logger.jsonl.event('file.unwritable',{step:1},{level:'warn'});
 await logger.flush();
 const failed=logger.diagnostics();
 if(failed.fileErrors<1||failed.sinkActive.jsonl)throw Error('EXPECTED_FILE_FAILURE_MISSING');
 rmSync(file,{recursive:true,force:true});
 await sleep(80);
 logger.jsonl.event('file.recovered',{step:2},{level:'info'});
 await logger.syncFiles();
 const recovered=logger.diagnostics();
 if(!recovered.sinkActive.jsonl||recovered.recovery.jsonl.successes<1)
  throw Error('EXPECTED_FILE_RECOVERY_MISSING');
 await logger.close();
 process.stdout.write(JSON.stringify({
  mode:'file-fault',
  fileErrors:recovered.fileErrors,
  recovery:recovered.recovery.jsonl,
  sinkActive:recovered.sinkActive
 })+'\n');
}else throw new Error('Unknown logger fault test mode: '+mode);
