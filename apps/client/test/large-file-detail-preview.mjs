import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RecordJournal} from '../dist/record-journal.js';
import {detailPresentation} from '../dist/detail-presentation.js';
import {missingSelectedFileSource} from '../dist/selected-file-preview.js';

test('large fs_write/fs_read activity cache retains a bounded useful text preview',()=>{
 const dir=mkdtempSync(join(tmpdir(),'db-file-preview-'));
 try{
  const journal=new RecordJournal(dir);
  const content='FILE_START\n'+'记录🪐\n'.repeat(25000)+'FILE_END\n';
  for(const kind of ['fs_write','fs_read']){
   const request=kind==='fs_write'?{path:'file.txt',mode:'rewrite',content}:{path:'file.txt'};
   const result=kind==='fs_read'?{path:'file.txt',content,readBytes:Buffer.byteLength(content)}:{path:'file.txt',writtenBytes:Buffer.byteLength(content)};
   const path=journal.start(kind,kind,request);
   journal.finish(kind,result,'completed');
   const preview=journal.getPreview(path);
   const i=JSON.parse(preview.input),r=JSON.parse(preview.result);
   assert.equal((kind==='fs_write'?i:r).previewLimited,true);
   assert.ok((kind==='fs_write'?i:r).content.includes('FILE_START'));
   assert.ok((kind==='fs_write'?i:r).content.includes('FILE_END'));
   const entry={id:kind,grant_id:'g',tool:kind,description:kind,status:'completed',time:Date.now(),
    request_json:preview.input,result:preview.result};
   assert.equal(missingSelectedFileSource(entry),kind==='fs_write'?'input':'result');
   const detail=detailPresentation(entry,entry.time);
   assert.ok(detail.some(line=>line.section===(kind==='fs_write'?'INPUT':'OUTPUT')));
   assert.ok(detail.some(line=>line.text.includes('FILE_START')));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('large fs_edit metadata preserves diffStored and full-result access in summary',()=>{
 const dir=mkdtempSync(join(tmpdir(),'db-edit-preview-'));
 try{
  const journal=new RecordJournal(dir);
  const id='large-edit';
  const request={path:'a.ts',mode:'replace_many',replacements:
   Array.from({length:15},(_,i)=>({oldText:'old'+i+' '.repeat(500),newText:'new'+i+' '.repeat(500)}))};
  const path=journal.start(id,'fs_edit',request);
  journal.finish(id,{path:'a.ts',changed:true,replacements:15,diffStored:true,diffBytes:35000,
   diffTruncated:true,diff:'Index: a.ts\n'+('---before\n+after\n'.repeat(850))},'completed');
  const cache=journal.getPreview(path);
  const i=JSON.parse(cache.input),r=JSON.parse(cache.result);
  assert.equal(i.previewLimited,true);
  assert.ok(i.previewInput.includes('replace_many'));
  assert.equal(r.previewLimited,true);
  assert.equal(r.diffStored,true);
  assert.equal(r.diffBytes,35000);
  assert.ok(r.diff.includes('Index: a.ts'));
  const entry={id,grant_id:'g',tool:'fs_edit',description:'edit',status:'completed',time:Date.now(),
   request_json:cache.input,result:cache.result};
  assert.equal(missingSelectedFileSource(entry),'input');
  const detail=detailPresentation(entry,entry.time);
  assert.ok(detail.some(row=>row.section==='OUTPUT'));
  assert.ok(detail.some(row=>row.section==='INPUT'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
