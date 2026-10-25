import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordJournal} from '../dist/record-journal.js';
import {detailPresentation} from '../dist/detail-presentation.js';

test('quote-heavy stdout does not turn the stable cached DETAIL into a generic placeholder',()=>{
 const dir=mkdtempSync(join(tmpdir(),'db-snapshot-escapes-'));
 try{
  const j=new RecordJournal(dir);
  const id='escaped',path=j.start(id,'exec_foreground',{command:{mode:'shell',script:'echo quoted'}});
  const stdout=Array.from({length:1800},(_,i)=>'line '+i+' '+String.fromCharCode(92).repeat(10)+String.fromCharCode(34)+'escaped'+String.fromCharCode(34)+String.fromCharCode(10)).join('');
  j.stream(id,'stdout',Buffer.from(stdout));
  j.finish(id,{exitCode:0},'completed');
  const saved=j.getPreview(path);
  const result=JSON.parse(saved.result);
  assert.equal(saved.result.length<=6000,true);
  assert.equal(result.outputPreviewKind,'head_tail');
  assert.ok(result.outputPreview.includes('line 0'));
  assert.ok(result.outputPreview.includes('line 1799'));
  assert.equal(result.outputPreviewMeta.totalLines,1800);
  const e={id,grant_id:'g',tool:'exec_foreground',status:'completed',
   time:Date.now(),description:'echo',request_json:saved.input,result:saved.result};
  const rows=detailPresentation(e,e.time);
  assert.equal(rows.some(row=>row.section==='OUTPUT'),true);
  assert.equal(rows.filter(row=>row.text==='…').length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('short output does not show a fake truncation notice or an omission row',()=>{
 const dir=mkdtempSync(join(tmpdir(),'db-preview-short-'));
 try{
  const journal=new RecordJournal(dir);
  const id='short',record=journal.start(id,'exec_foreground',{command:{mode:'shell',script:'echo hi'}});
  journal.stream(id,'stdout',Buffer.from('a\nb\nc\n'));
  journal.finish(id,{exitCode:0},'completed');
  const p=journal.getPreview(record);
  const rows=detailPresentation({id,grant_id:'g',tool:'exec_foreground',
   description:'short',status:'completed',time:Date.now(),request_json:p.input,result:p.result},Date.now());
  assert.ok(!rows.some(row=>row.text==='…'||/截断|省略|查看完整/.test(row.text)));
  assert.deepEqual(rows.filter(row=>typeof row.sourceLine==='number').map(row=>row.sourceLine).slice(-3),[1,2,3]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
