import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RecordJournal} from '../dist/record-journal.js';
import {loadSelectedFilePreview,missingSelectedFileSource,withSelectedFilePreview} from '../dist/selected-file-preview.js';
import {detailPresentation} from '../dist/detail-presentation.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-lazy-file-preview-'));
try{
 const store=new RecordJournal(join(root,'records'));
 const list=[];
 function recorded(id,tool,input,result){
  const path=store.start(id,tool,input);
  store.finish(id,result,'completed');
  const preview=store.getPreview(path);
  const entry={id,grant_id:'fixture',tool,description:tool,status:'completed',time:Date.now(),
   record_state:'complete',request_json:preview.input,result:preview.result};
  list.push(entry);
  return{path,entry,preview};
 }
 const writeText='// a long historical write survived\n'+'const count = 42;\n'.repeat(460);
 const fileWrite=recorded('write-large','fs_write',
  {path:'E:/example/output.ts',mode:'rewrite',content:writeText},
  {path:'E:/example/output.ts',writtenBytes:Buffer.byteLength(writeText),sha256:'abc'});
 const oldInput=JSON.parse(fileWrite.preview.input);
 assert.equal(oldInput.previewLimited,true);
 assert.equal(oldInput.path,'E:/example/output.ts');
 assert.equal(oldInput.content,undefined,'activity list must not fetch huge text');
 let calls=0;
 async function load(data){
  return loadSelectedFilePreview(data.entry,async req=>{
   assert.ok(req.maxBytes<=65536,'IPC must never exceed its 64KiB page budget');
   calls++;
   return store.getRecordStream(data.path,req.action,req.byteOffset,req.maxBytes);
  });
 }
 const fullWrite=await load(fileWrite);
 assert.equal(fullWrite.source,'input');
 const hydratedWrite=withSelectedFilePreview(fileWrite.entry,fullWrite);
 assert.equal(JSON.parse(hydratedWrite.request_json).content,writeText);
 const writeDetail=detailPresentation(hydratedWrite,0).map(x=>x.text).join('\n');
 assert.match(writeDetail,/FILE CONTENT/);
 assert.match(writeDetail,/long historical write survived/);
 assert.doesNotMatch(writeDetail,/历史记录未保存/);

 const readText='// an actual returned file read\n'+'let number = 1;\n'.repeat(530);
 const fileRead=recorded('read-large','fs_read',{path:'E:/example/input.ts',lineOffset:5,maxLines:1000},
  {path:'E:/example/input.ts',content:readText,readBytes:Buffer.byteLength(readText),linesRead:531,lineOffset:5});
 assert.equal(JSON.parse(fileRead.preview.result).previewLimited,true);
 const fullRead=await load(fileRead);
 assert.equal(JSON.parse(withSelectedFilePreview(fileRead.entry,fullRead).result).content,readText);
 assert.match(detailPresentation(withSelectedFilePreview(fileRead.entry,fullRead),0).map(x=>x.text).join('\n'),/actual returned file read/);

 const contents=Array.from({length:7},(_,i)=>'// ORIGINAL SOURCE FILE '+i+'\n'+'const v = '+i+';\n'.repeat(410));
 const many=recorded('read-many-large','fs_read_many',{files:contents.map((_,i)=>({path:'E:/firmware/module'+i+'.ts'}))},
  {successCount:7,failureCount:0,bytesUsed:contents.reduce((sum,s)=>sum+Buffer.byteLength(s),0),
   files:contents.map((content,i)=>({path:'E:/firmware/module'+i+'.ts',content,readBytes:Buffer.byteLength(content)}))});
 const compactResult=JSON.parse(many.preview.result);
 assert.equal(compactResult.successCount,7,'list must preserve real successCount not show 0');
 assert.equal(compactResult.failureCount,0);
 assert.equal(compactResult.previewLimited,true);
 assert.ok(compactResult.files.every(file=>!('content'in file)));
 const fullMany=await load(many);
 assert.ok(fullMany?.available);
 const hydratedMany=withSelectedFilePreview(many.entry,fullMany);
 const fullResult=JSON.parse(hydratedMany.result);
 assert.equal(fullResult.files.length,7);
 assert.equal(fullResult.files[5].content,contents[5]);
 const detail=detailPresentation(hydratedMany,0).map(x=>x.text).join('\n');
 assert.match(detail,/ORIGINAL SOURCE FILE 0/);
 assert.match(detail,/ORIGINAL SOURCE FILE 5/);
 assert.ok(detailPresentation(hydratedMany,0).some(row=>row.label==='SUCCESS'),'Batch success metadata should be visible');
 assert.doesNotMatch(detail,/历史记录未保存/);

 const small=recorded('small-write','fs_write',{path:'small.txt',mode:'create',content:'hello'}, {writtenBytes:5});
 const before=calls;
 assert.equal(missingSelectedFileSource(small.entry),null);
 assert.equal(await load(small),null);
 assert.equal(calls,before,'already available preview must not re-read journal');

 const mediumText='const result=1;\n'.repeat(5600);
 const medium=recorded('two-pages','fs_write',{path:'medium.ts',mode:'create',content:mediumText},{writtenBytes:Buffer.byteLength(mediumText)});
 const beforePaging=calls;
 const restoredMedium=await load(medium);
 assert.equal(JSON.parse(withSelectedFilePreview(medium.entry,restoredMedium).request_json).content,mediumText);
 assert.equal(calls,beforePaging+2,'64KiB IPC pages must reconstruct a 90KiB historical input');
 const beforeOversized=calls;
 const large=recorded('oversized','fs_write',{path:'large.txt',mode:'create',content:'x'.repeat(150000)},
  {writtenBytes:150000});
 const bounded=await load(large);
 assert.equal(bounded.limited,true);
 assert.equal(bounded.json,undefined,'oversized records must remain in full inspector, not activity cache');
 assert.equal(calls,beforeOversized+1);
 assert.equal(list.length,6);
 console.log('PASS actual JSONL >6K fs_write/fs_read/fs_read_many, counts, selected IPC loading, 128KiB limit, and no extra reads');
}finally{rmSync(root,{recursive:true,force:true});}
