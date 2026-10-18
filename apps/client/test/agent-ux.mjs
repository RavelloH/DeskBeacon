import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {networkTool} from '../dist/system.js';
import {TaskSupervisor} from '../dist/process.js';

const server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise(resolve=>server.close(resolve));
const tcp=await networkTool('net_probe',{mode:'tcp',host:'127.0.0.1',port,timeoutMs:2000});
assert.equal(tcp.connected,false,'Connection refusal must be a successful diagnostic response');
assert.equal(tcp.mode,'tcp');
assert.ok(tcp.errorCode);
assert.ok(tcp.durationMs>=0);
console.log('PASS TCP connection refused is structured data, not a tool exception');
const tls=await networkTool('net_probe',{mode:'tls',host:'127.0.0.1',port,timeoutMs:2000});
assert.equal(tls.connected,false);
assert.equal(tls.mode,'tls');
console.log('PASS TLS failure is structured data');

const root=mkdtempSync(join(tmpdir(),'beacon-agent-ux-'));
const outDir=join(root,'output');mkdirSync(outDir,{recursive:true});
const db=new DatabaseSync(join(root,'state.sqlite'));
try{
 const supervisor=new TaskSupervisor(db,outDir);
 const stdout=join(outDir,'output.out'),stderr=join(outDir,'output.err');
 writeFileSync(stdout,'line-one\nline-two\nline-three\n');
 writeFileSync(stderr,'warning\n');
 db.prepare("INSERT INTO background(id,operation_id,description,pid,status,start,stdout_path,stderr_path) VALUES(?,?,?,?,?,?,?,?)")
  .run('test-job','test-job','Fixture',99,'exited',Date.now(),stdout,stderr);
 const first=supervisor.output('test-job','stdout',0,1000,1);
 assert.equal(first.results[0].text,'line-one\n');
 assert.equal(first.results[0].nextOffset,9);
 assert.equal(first.results[0].hasMore,true);
 const second=supervisor.output('test-job','stdout',first.results[0].nextOffset,1000,1);
 assert.equal(second.results[0].text,'line-two\n');
 assert.equal(second.results[0].nextOffset,18);
 console.log('PASS background output supports maxLines and byte offsets for pagination');
}finally{
 db.close();
 rmSync(root,{force:true,recursive:true,maxRetries:4,retryDelay:50});
}
