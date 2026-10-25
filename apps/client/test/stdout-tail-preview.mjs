import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordJournal} from '../dist/record-journal.js';
import {detailPresentation,numberedPreviewBlock} from '../dist/detail-presentation.js';

test('journal tail preview labels truncated stdout without inventing first-line numbers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'deskbeacon-stdout-preview-'));
 try{
  const journal=new RecordJournal(dir);
  const id='tail-preview-'+Date.now();
  const path=journal.start(id,'exec_foreground',{command:{mode:'shell',script:'node reporter.js'}});
  const stdout=JSON.stringify({
   limitations:['first','second','third'],data:Array.from({length:250},(_,i)=>({cell:i,seaIce:i*7,salt:i*.035})),
   final:'LAST_OUTPUT_SENTINEL'
  },null,2)+'\n';
  journal.stream(id,'stdout',Buffer.from(stdout,'utf8'));
  journal.finish(id,{exitCode:0,timedOut:false},'completed');
  const preview=JSON.parse(journal.getPreview(path).result);
  assert.equal(preview.outputPreviewKind,'head_tail');
  assert.equal(preview.previewTruncated,true);
  assert.equal(preview.outputPreviewMeta.truncated,true);
  assert.ok(preview.outputPreview.includes('limitations'));
  assert.ok(preview.outputPreview.endsWith('LAST_OUTPUT_SENTINEL"\n}\n'));
  assert.ok(preview.outputPreview.includes('中间省略'));
  assert.equal(preview.outputPreviewMeta.totalLines,stdout.split('\n').length-1);
  assert.ok(preview.outputPreviewMeta.tailStartLine>1);
  const raw=journal.getRecordStream(path,'stdout',0,65536);
  assert.equal(raw.text,stdout,'full stdout must remain unchanged in journal');
  const entry={id,tool:'exec_foreground',description:'report',status:'completed',
   time:Date.now(),grant_id:'agent',actor_name:'ChatGPT',
   request_json:journal.getPreview(path).input,result:JSON.stringify(preview)};
  const summary=detailPresentation(entry,entry.time);
  assert.ok(summary.some(v=>v.section==='OUTPUT'));
  assert.ok(summary.some(v=>v.gutterLabel==='...'&&v.text.includes('已隐藏')&&v.text.includes('按 o 展开')), 'middle-clipped output needs an inline omission row');
  const numbered=summary.filter(v=>typeof v.sourceLine==='number');
  assert.equal(numbered[0].sourceLine,1);
  assert.equal(numbered.at(-1).sourceLine,preview.outputPreviewMeta.totalLines);
  assert.ok(numbered.some((row,index)=>index>0&&row.sourceLine-numbered[index-1].sourceLine>1),
   'the omitted middle must not generate false line numbers');
  assert.ok(!summary.some(v=>v.text.includes('预览已省略')||v.text.includes('按 o 查看完整')),
   'the inline marker is the only truncation prompt');
 }finally{rmSync(dir,{force:true,recursive:true});}
});

test('short stdout previews remain untruncated while still being described as previews',()=>{
 const dir=mkdtempSync(join(tmpdir(),'deskbeacon-stdout-short-'));
 try{
  const journal=new RecordJournal(dir);
  const path=journal.start('short','exec_foreground',{command:{mode:'shell',script:'echo hello'}});
  journal.stream('short','stdout',Buffer.from('hello\n'));
  journal.finish('short',{exitCode:0},'completed');
  const preview=JSON.parse(journal.getPreview(path).result);
  assert.equal(preview.previewTruncated??false,false);
  assert.equal(preview.outputPreviewOmittedBytes,0);
  assert.equal(preview.outputPreview,'hello\n');
  assert.equal(preview.outputPreviewMeta.totalLines,1);
 }finally{rmSync(dir,{force:true,recursive:true});}
});


test('1..1180 source line numbers survive balanced first-and-last clipping',()=>{
 const source=Array.from({length:1180},(_,i)=>'line-'+String(i+1).padStart(4,'0')).join('\n');
 const dir=mkdtempSync(join(tmpdir(),'deskbeacon-line-'));
 try{
  const journal=new RecordJournal(dir),id='numbered-lines';
  const record=journal.start(id,'exec_foreground',{command:{mode:'shell',script:'demo'}});
  journal.stream(id,'stdout',Buffer.from(source));
  journal.finish(id,{exitCode:0},'completed');
  const result=JSON.parse(journal.getPreview(record).result);
  assert.equal(result.outputPreviewMeta.totalLines,1180);
  const entry={id,tool:'exec_foreground',description:'test',status:'completed',
   time:Date.now(),grant_id:'agent',request_json:journal.getPreview(record).input,
   result:JSON.stringify(result)};
  const numbered=detailPresentation(entry,entry.time).filter(item=>typeof item.sourceLine==='number')
   .map(item=>item.sourceLine);
  assert.equal(numbered[0],1);
  assert.deepEqual(numbered.slice(-3),[1178,1179,1180]);
  assert.ok(numbered.some((line,i)=>i>0&&line-numbered[i-1]>1));
  assert.equal(journal.getRecordStream(record,'stdout',0,100).totalLines,1180);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
