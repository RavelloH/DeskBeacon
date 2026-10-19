import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {outputEncoding,decodeOutputText,decodeOutputPage,windowsLegacyEncoding,detectFileOutputEncoding} from '../dist/output-encoding.js';
import {TaskSupervisor} from '../dist/process.js';

// Test a GBK-emitting Windows program even on English-locale CI runners.
if(process.platform==='win32')process.env.DESKBEACON_OEM_ENCODING='gb18030';
const cp936=Buffer.from('d5fdd4da2050696e67203132372e302e302e3120bedfd3d020333220d7d6bddab5c4cafdbedd3a','hex');
const chinese='正在 Ping 127.0.0.1 具有 32 字节的数据:';
assert.equal(new TextDecoder('gb18030').decode(cp936),chinese);
assert.equal(decodeOutputText(Buffer.from('中文与 emoji 🙂','utf8')),'中文与 emoji 🙂');
if(process.platform==='win32'){
 assert.equal(windowsLegacyEncoding(),'gb18030','fixture expects a Windows 936 console');
 assert.equal(outputEncoding(cp936),'gb18030');
 assert.equal(decodeOutputText(cp936),chinese);
 let offset=0,assembled='';
 while(offset<cp936.length){
  const page=decodeOutputPage(cp936.subarray(offset,offset+6),3,'gb18030');
  assert.ok(page.used>0,'OEM pagination must advance');
  assembled+=page.text;offset+=page.used;
 }
 assert.equal(assembled,chinese,'a GBK character split across pages must survive');

 const root=mkdtempSync(join(tmpdir(),'deskbeacon-cp936-'));
 const db=new DatabaseSync(join(root,'state.sqlite'));
 const supervisor=new TaskSupervisor(db,join(root,'output'));
 try{
  const lateFile=join(root,'late-cp936.out');
  writeFileSync(lateFile,'ASCII startup: '.repeat(5600));
  assert.equal(detectFileOutputEncoding(lateFile),'utf-8','ASCII-only startup is valid UTF-8');
  appendFileSync(lateFile,cp936);
  assert.equal(detectFileOutputEncoding(lateFile,readFileSync(lateFile).length-10),'gb18030',
   'incremental scan must catch GBK first appearing after 64 KiB');

  const code="const b=Buffer.from('"+cp936.toString('hex')+"','hex');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stderr.write(b);},35)";
  const result=await supervisor.foreground('cp936-foreground','GBK stdout and stderr',
   {mode:'program',program:process.execPath,args:['-e',code]},10000);
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout,chinese);
  assert.equal(result.stderr,chinese);
  assert.deepEqual(readFileSync(join(root,'output','cp936-foreground.out')),cp936,
   'stored raw stdout bytes must remain unchanged');
  console.log('PASS foreground Agent result decodes CP936 split across stream chunks, original log preserved');

  const background=await supervisor.startBackground('cp936-background','GBK background',
   {mode:'program',program:process.execPath,
    args:['-e',"process.stdout.write(Buffer.from('"+cp936.toString('hex')+"','hex'));setTimeout(()=>{},1400)"]});
  assert.ok(background.backgroundTaskId);
  let found=false;
  for(let i=0;i<40;i++){
   await new Promise(r=>setTimeout(r,70));
   const line=supervisor.latestLine('cp936-background');
   if(line.includes('正在 Ping')){found=true;break;}
  }
  assert.ok(found,'TUI live-output must decode OEM from raw log');
  const read=supervisor.output('cp936-background','stdout',0,100,50);
  assert.ok(read.results[0].text.includes(chinese),'background_output Agent text must be readable');
  await supervisor.stop('cp936-background');
  console.log('PASS live-output and background_output decode historical raw CP936');
 }finally{
  await new Promise(r=>setTimeout(r,250));
  db.close();
  rmSync(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
 }
}else{
 assert.equal(outputEncoding(cp936),'utf-8','Linux must not apply a Windows OEM codepage');
 console.log('SKIP Windows OEM subprocess; Linux output remains UTF-8');
}
console.log('PASS Windows native/OEM and UTF-8 output encoding tests');
