import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordJournal,recordRelativePath} from '../dist/record-journal.js';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-record-v2-'));
try{
 const output=[];const store=new RecordJournal(join(root,'records'),(id,stream,size)=>output.push([id,stream,size]));
 const id='batch:child/unsafe',time=new Date('2026-10-20T03:00:00.000Z').getTime();
 const ref=store.start(id,'exec_foreground',{command:{script:'echo 中文'},token:'SECRET_TOKEN',env:{SECRET:'123'},content:'hello'},{time});
 assert.match(ref,/^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[a-f0-9]{64}\.jsonl$/);
 assert.deepEqual(store.getInput(ref),{command:{script:'echo 中文'},token:'[redacted]',env:'[redacted]',content:'hello'});
 store.stream(id,'stdout',Buffer.from('hello 中文\n'));
 store.stream(id,'stderr',Buffer.from('warning\n'));
 store.finish(id,{exitCode:0,stdout:'hello 中文\n',stderr:'warning\n',durationMs:20},'completed');
 const result=store.getResult(ref);
 assert.equal(result?.status,'completed');assert.equal(result?.result.stdout,'hello 中文\n');assert.equal(result?.result.stderr,'warning');
 assert.equal(result?.result.exitCode,0);
 const p=store.getRecordStream(ref,'stdout',0,65536);assert.equal(p.text,'hello 中文\n');
 const utf='你好吗🙂abc';const utfId='tiny-utf8-pages';const utfRef=store.start(utfId,'exec_foreground',{});store.stream(utfId,'stdout',Buffer.from(utf));store.finish(utfId,{exitCode:0},'completed');
 let utfOffset=0,utfFull='',pageCount=0;for(;;){const part=store.getRecordStream(utfRef,'stdout',utfOffset,1);utfFull+=part.text;utfOffset=part.nextOffset;if(!part.hasMore)break;assert.ok(++pageCount<40);}
 assert.equal(utfFull,utf);assert.throws(()=>store.getRecordStream(utfRef,'stdout',1,1),/INVALID_BYTE_OFFSET/);
 const pi=store.getRecordStream(ref,'input',0,65536);assert.match(pi.text,/echo 中文/);
 assert.equal(output.length,3);assert.ok(existsSync(store.path(ref)));
 const bg='long-background';const rb=store.start(bg,'exec_background',{description:'long'}, {isBackground:true});
 store.finish(bg,{status:'running',backgroundTaskId:bg},'completed',{background:true});
 store.stream(bg,'stdout',Buffer.from('after call_finish'));
 assert.equal(store.getRecordStream(rb,'stdout',0,100).text,'after call_finish');
 store.processExit(bg,0);assert.equal(store.getResult(rb)?.status,'completed');
 const corrupt='cut-tail';const rc=store.start(corrupt,'fs_read',{path:'x'});
 store.finish(corrupt,{ok:true},'completed');
 const file=store.path(rc);const {appendFileSync}=await import('node:fs');appendFileSync(file,'{"v":1,"type":"broken"');
 assert.equal(store.getResult(rc)?.result.ok,true);
 // Binary bytes are preserved through base64.
 const bin='raw-oem';const rp=store.start(bin,'exec_foreground',{});store.stream(bin,'stderr',Buffer.from([0xc4,0xe3,0xba,0xc3]));store.finish(bin,{exitCode:1},'completed');
 assert.equal(store.getRecordStream(rp,'stderr',0,65536).totalBytes,4);
 console.log('PASS JSONL records, replay, paging, secret redaction, background lifecycle, partial tail');
}finally{rmSync(root,{recursive:true,force:true});}
