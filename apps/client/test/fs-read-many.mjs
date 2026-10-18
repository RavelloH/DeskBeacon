import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileTool} from '../dist/filesystem.js';
import {toolInputSchemas} from '../../../packages/protocol/dist/tools.js';

const dir=mkdtempSync(join(tmpdir(),'deskbeacon-multi-read-'));
try{
 const alpha=join(dir,'alpha.txt'),beta=join(dir,'beta.txt'),large=join(dir,'large.txt');
 writeFileSync(alpha,'first\nsecond\nthird\nfourth\n');
 writeFileSync(beta,'value=42\n');
 const binary=Buffer.alloc(1_300_000,65);
 writeFileSync(large,binary);
 const payload={deviceId:'test-device',workspaceId:'test-workspace',
  files:[{path:'alpha.txt',lineOffset:1,maxLines:2,maxBytes:100},{path:'beta.txt',maxBytes:100}],
  includeHash:true,maxTotalBytes:1024};
 const parsed=toolInputSchemas.fs_read_many.parse(payload);
 const result=await fileTool('fs_read_many',parsed,dir);
 assert.equal(result.successCount,2);
 assert.equal(result.failureCount,0);
 assert.equal(result.files[0].content,'second\nthird');
 assert.equal(result.files[0].truncated,true);
 assert.equal(result.files[0].nextLineOffset,3);
 assert.equal(result.files[1].content,'value=42\n');
 assert.equal(result.files[0].sha256,createHash('sha256').update('first\nsecond\nthird\nfourth\n').digest('hex'));
 assert.ok(result.bytesUsed<=result.maxTotalBytes);
 console.log('PASS multi-file range, lines, continuation, hashes and provenance');

 const errors=await fileTool('fs_read_many',{
   files:[{path:'missing.txt',maxBytes:50},{path:'beta.txt',maxBytes:50}],
   maxTotalBytes:1024,
 },dir);
 assert.equal(errors.failureCount,1);
 assert.match(errors.files[0].error,/ENOENT/);
 assert.equal(errors.files[1].content,'value=42\n');
 console.log('PASS one missing file does not discard remaining reads');

 const capped=await fileTool('fs_read_many',{
   files:[{path:'large.txt',maxBytes:1024},{path:'beta.txt',maxBytes:100}],
   maxTotalBytes:1024,
 },dir);
 assert.equal(capped.files[0].readBytes,1024);
 assert.equal(capped.files[0].truncated,true);
 assert.equal(capped.files[0].nextByteOffset,1024);
 assert.equal(capped.files[1].error,'BATCH_BUDGET_EXHAUSTED');
 console.log('PASS aggregate byte cap enforced across files');

 const largeHash=await fileTool('fs_read_many',{
   files:[{path:'large.txt',maxBytes:10}],includeHash:true,maxTotalBytes:1024,
 },dir);
 assert.equal(largeHash.files[0].sha256,createHash('sha256').update(binary).digest('hex'));
 assert.equal(largeHash.files[0].readBytes,10);
 console.log('PASS SHA-256 streaming on larger file without returning entire contents');

 assert.equal(toolInputSchemas.fs_read_many.safeParse({
   deviceId:'test-device',files:Array.from({length:9},()=>({path:'a'})),
 }).success,false);
 assert.equal(toolInputSchemas.fs_read_many.safeParse({
   deviceId:'test-device',files:[{path:'a',maxBytes:999_999}],
 }).success,false);
 console.log('PASS protocol schema enforces file count and per-file byte bounds');
}finally{
 rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
