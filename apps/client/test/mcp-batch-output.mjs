import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-batch-recovery-'));
process.env.DESKBEACON_DATA_DIR=root;
const {ClientDaemon}=await import('../dist/daemon.js');
const daemon=new ClientDaemon({url:'https://127.0.0.1.invalid',deviceId:'test-device',deviceName:'test',
  clientId:'test-client',accessToken:'test-only'});
try{
 const id='recovery-parent-1',grant='grant-A';
 const request={deviceId:'test-device',description:'检查批量子操作输出可恢复性',maxResultBytes:4096,
  stages:[{parallel:false,failFast:true,calls:[{id:'long-output',tool:'exec_foreground',
   input:{description:'长输出',command:{mode:'program',program:'node',
    args:['-e',"process.stdout.write('X'.repeat(9000)+'\\nEND_MARKER_123')"]},timeoutMs:10000}}]}]};
 const path=daemon.journal.start(id,'batch',request);
 daemon.db.prepare('INSERT INTO activity(id,grant_id,tool,record_path,status,time) VALUES(?,?,?,?,?,?)')
  .run(id,grant,'batch',path,'running',Date.now());
 const result=await daemon.execute('batch',request,id,grant);
 daemon.journal.finish(id,result,'completed');
 const child=result.stages[0].results[0];
 assert.equal(child.ok,true,JSON.stringify(child.error));
 assert.equal(child.childOperationId,id+':long-output');
 assert.ok(child.truncated||child.result.data.stdoutTruncated,'subcall should have a bounded preview');
 let cursor=0,recovered='';
 while(true){
  const page=await daemon.execute('batch_output',{parentOperationId:id,callId:'long-output',
   stream:'stdout',byteOffset:cursor,maxBytes:3500},'read-child-'+cursor,grant);
  recovered+=page.text;cursor=page.nextOffset;
  if(!page.hasMore)break;
 }
 assert.match(recovered,/END_MARKER_123/);
 assert.ok(recovered.length>=9000);
 await assert.rejects(()=>daemon.execute('batch_output',{parentOperationId:id,callId:'long-output',
   stream:'stdout',byteOffset:0,maxBytes:500},'rejected-child','grant-B'),/OPERATION_UNKNOWN/);
 console.log('PASS child output can be paged after a 4KiB batch preview and rejects other grants');

 const opened=await daemon.execute('workspace_open',{path:root,workspaceId:'named-workspace'},'ws1',grant);
 assert.equal(opened.workspaceId,'named-workspace');
 const reopened=await daemon.execute('workspace_open',{path:root,workspaceId:'named-workspace'},'ws2',grant);
 assert.equal(reopened.reused,true);
 assert.equal(reopened.version,0);
 await assert.rejects(()=>daemon.execute('workspace_open',
   {path:root,workspaceId:'named-workspace'},'ws3','grant-B'),/WORKSPACE_FORBIDDEN/);
 console.log('PASS explicit workspace ID is honored and grant-isolated');

 const source=join(root,'large.bin');
 const bytes=Buffer.alloc(310000,97);
 writeFileSync(source,bytes);
 let resultBytes=Buffer.alloc(0),offset=0,chunks=0;
 while(true){
  const page=await daemon.execute('transfer_download',
    {sourcePath:source,description:'分块下载测试',offset,maxBytes:131072},'trans-'+chunks,grant);
  resultBytes=Buffer.concat([resultBytes,Buffer.from(page.dataBase64,'base64')]);
  assert.equal(page.offset,offset);
  assert.equal(page.totalBytes,bytes.length);
  offset=page.nextOffset;chunks++;
  if(!page.hasMore)break;
 }
 assert.deepEqual(resultBytes,bytes);
 assert.equal(chunks,3);
 console.log('PASS transfer_download pages a file exceeding 128KiB');
}finally{
 daemon.db.close();
 rmSync(root,{force:true,recursive:true});
}
