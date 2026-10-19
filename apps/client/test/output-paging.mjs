import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture=await mkdtemp(join(tmpdir(),'deskbeacon-output-paging-'));
process.env.DESKBEACON_DATA_DIR=join(fixture,'data');
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'
  ? `\\\\.\\pipe\\deskbeacon-output-paging-${process.pid}`
  : join(fixture,'daemon.sock');

const [{ClientDaemon,dataDir},{startIpc,requestIpc}]=await Promise.all([
  import('../dist/daemon.js'),import('../dist/ipc.js'),
]);
const daemon=new ClientDaemon({url:'https://worker.example.test',deviceId:'output-fixture',
  clientId:'output-fixture',accessToken:'fixture-only',deviceName:'Output fixture'});
const listener=startIpc(daemon);
const outputDir=join(dataDir,'output');
await mkdir(outputDir,{recursive:true});
const expectIpcError=(request,code)=>assert.rejects(requestIpc(request),new RegExp(code));

try{
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal((await daemon.status()).state,'disconnected','fixture must not connect to a remote Worker');
  assert.equal((await requestIpc({action:'status'})).server,'https://worker.example.test');

  const operationId='paging-fixture-1';
  const body='你好吗🙂abc';
  await writeFile(join(outputDir,operationId+'.out'),Buffer.from(body,'utf8'));
  const first=await requestIpc({action:'output',operationId,stream:'stdout',maxBytes:1});
  assert.deepEqual(first,{text:'你',nextOffset:3,totalBytes:Buffer.byteLength(body),hasMore:true,stream:'stdout'});
  let page=first,assembled=page.text,pages=0;
  while(page.hasMore){
    page=await requestIpc({action:'output',operationId,stream:'stdout',byteOffset:page.nextOffset,maxBytes:1});
    assembled+=page.text;
    assert.ok(page.nextOffset>0,'tiny budgets must continue advancing at UTF-8 boundaries');
    assert.ok(++pages<20,'pagination must terminate');
  }
  assert.equal(assembled,body);
  const eof=await requestIpc({action:'output',operationId,stream:'stdout',byteOffset:Buffer.byteLength(body)});
  assert.deepEqual(eof,{text:'',nextOffset:Buffer.byteLength(body),totalBytes:Buffer.byteLength(body),hasMore:false,stream:'stdout'});

  const defaultId='default-budget-fixture';
  await writeFile(join(outputDir,defaultId+'.out'),'x'.repeat(16*1024+7));
  const defaultPage=await requestIpc({action:'output',operationId:defaultId,stream:'stdout'});
  assert.equal(Buffer.byteLength(defaultPage.text),16*1024);
  assert.equal(defaultPage.nextOffset,16*1024);
  assert.equal(defaultPage.totalBytes,16*1024+7);

  const maxId='max-budget-fixture';
  await writeFile(join(outputDir,maxId+'.err'),'m'.repeat(64*1024+5));
  const maxPage=await requestIpc({action:'output',operationId:maxId,stream:'stderr',maxBytes:64*1024});
  assert.equal(Buffer.byteLength(maxPage.text),64*1024);
  assert.equal(maxPage.nextOffset,64*1024);
  assert.equal(maxPage.hasMore,true);

  const missing=await requestIpc({action:'output',operationId:'missing-fixture',stream:'stderr'});
  assert.deepEqual(missing,{text:'',nextOffset:0,totalBytes:0,hasMore:false,stream:'stderr'});
  assert.ok((await requestIpc({action:'logs',operationId})).outputs.some(output=>output.filename===operationId+'.out'),
    'legacy logs action must still include output files');

  await expectIpcError({action:'output',operationId:'../secret',stream:'stdout'},'INVALID_OPERATION_ID');
  await expectIpcError({action:'output',operationId,stream:'both'},'INVALID_OUTPUT_STREAM');
  await expectIpcError({action:'output',operationId,stream:'stdout',byteOffset:-1},'INVALID_BYTE_OFFSET');
  await expectIpcError({action:'output',operationId,stream:'stdout',byteOffset:1},'INVALID_BYTE_OFFSET');
  await expectIpcError({action:'output',operationId,stream:'stdout',byteOffset:1.5},'INVALID_BYTE_OFFSET');
  await expectIpcError({action:'output',operationId,stream:'stdout',byteOffset:Buffer.byteLength(body)+1},'INVALID_BYTE_OFFSET');
  await expectIpcError({action:'output',operationId,stream:'stdout',maxBytes:0},'INVALID_OUTPUT_BUDGET');
  await expectIpcError({action:'output',operationId,stream:'stdout',maxBytes:64*1024+1},'INVALID_OUTPUT_BUDGET');
  console.log('PASS local output paging, UTF-8 boundaries, budgets, EOF and input validation');

  const grantId='trusted-actor-fixture';
  for(const [id,actorName] of [['old-null',null],['old-empty',''],['old-generic','Agent'],['other-grant',null]]){
    daemon.db.prepare('INSERT INTO activity(id,grant_id,actor_name,tool,description,status,time) VALUES(?,?,?,?,?,?,?)')
      .run(id,id==='other-grant'?'different-grant':grantId,actorName,'fixture','old operation','completed',Date.now());
  }
  const toolName='fixture_tool',input={},operationIdForActor='actor-backfill-fixture';
  const requestHash=createHash('sha256').update(JSON.stringify([toolName,input])).digest('hex');
  daemon.send=()=>{};
  daemon.execute=async()=>({ok:true});
  daemon.final=async()=>{};
  await daemon.dispatch({type:'operation.dispatch',operationId:operationIdForActor,toolName,input,grantId,
    actorName:'  Claude\u0000 Code\u202e'+'x'.repeat(100),requestHash,
    expiresAt:new Date(Date.now()+60_000).toISOString()});
  const names=daemon.db.prepare('SELECT id,actor_name FROM activity WHERE id IN (?,?,?,?,?) ORDER BY id')
    .all('old-null','old-empty','old-generic','other-grant',operationIdForActor);
  const nameById=Object.fromEntries(names.map(row=>[row.id,row.actor_name]));
  const safeName='Claude Code'+'x'.repeat(69);
  assert.equal(safeName.length,80);
  assert.equal(nameById['old-null'],safeName);
  assert.equal(nameById['old-empty'],safeName);
  assert.equal(nameById['old-generic'],safeName);
  assert.equal(nameById['other-grant'],null,'actor names must not cross OAuth grants');
  assert.equal(nameById[operationIdForActor],safeName);
  console.log('PASS trusted OAuth actor name sanitization and same-grant activity backfill');
  const longContent='中文文字和表情 🙂\\n'.repeat(2100);
  const inputForInspection={path:'/tmp/large-file.txt',mode:'create',content:longContent,
   env:{PASSWORD:'sensitive-do-not-store'}};
  const fullId='complete-input-fixture',fullTool='fs_write';
  const fullHash=createHash('sha256').update(JSON.stringify([fullTool,inputForInspection])).digest('hex');
  await daemon.dispatch({type:'operation.dispatch',operationId:fullId,toolName:fullTool,
   input:inputForInspection,grantId,actorName:'Agent',requestHash:fullHash,
   expiresAt:new Date(Date.now()+60_000).toISOString()});
  const firstInput=await requestIpc({action:'input',operationId:fullId,maxBytes:1024});
  assert.equal(firstInput.stream,'input');
  assert.ok(firstInput.hasMore);
  let combinedInput=firstInput.text, next=firstInput;
  for(let n=0;next.hasMore&&n<150;n++){
   next=await requestIpc({action:'input',operationId:fullId,byteOffset:next.nextOffset,maxBytes:1024});
   combinedInput+=next.text;
  }
  const preserved=JSON.parse(combinedInput);
  assert.equal(preserved.content,longContent,'full local input must not inherit activity-index truncation');
  assert.equal(preserved.env,'[redacted]','environment secrets must not be stored verbatim');
  assert.ok(!combinedInput.includes('sensitive-do-not-store'));
  const oldInput=await requestIpc({action:'input',operationId:'legacy-missing-input'});
  assert.equal(oldInput.available,false);
  console.log('PASS full local input IPC pagination with sensitive-field redaction and legacy fallback');
}finally{
  await new Promise(resolve=>listener.close(resolve));
  daemon.stop();
  await rm(fixture,{recursive:true,force:true,maxRetries:15,retryDelay:150});
}
