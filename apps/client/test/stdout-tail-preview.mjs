import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordJournal} from '../dist/record-journal.js';
import {detailPresentation} from '../dist/detail-presentation.js';
import {detailLines} from '../dist/presenter.js';

test('journal tail preview labels truncated stdout without inventing first-line numbers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'deskbeacon-stdout-preview-'));
 try{
  const journal=new RecordJournal(dir);
  const id='tail-preview-'+Date.now();
  const path=journal.start(id,'exec_foreground',{command:{mode:'shell',script:'node reporter.js'}});
  const stdout=JSON.stringify({
   limitations:['first','second','third'],data:Array.from({length:38},(_,i)=>({cell:i,seaIce:i*7,salt:i*.035})),
   final:'LAST_OUTPUT_SENTINEL'
  },null,2)+'\n';
  journal.stream(id,'stdout',Buffer.from(stdout,'utf8'));
  journal.finish(id,{exitCode:0,timedOut:false},'completed');
  const preview=JSON.parse(journal.getPreview(path).result);
  assert.equal(preview.outputPreviewKind,'tail');
  assert.equal(preview.previewTruncated,true);
  assert.equal(preview.outputPreviewOmittedChars,stdout.length-384);
  assert.equal(preview.outputPreview,stdout.slice(-384).trim());
  assert.ok(!preview.outputPreview.includes('"limitations"'),'tail is not the output beginning');
  const raw=journal.getRecordStream(path,'stdout',0,65536);
  assert.equal(raw.text,stdout,'full stdout must remain unchanged in journal');
  const entry={id,tool:'exec_foreground',description:'report',status:'completed',
   time:Date.now(),grant_id:'agent',actor_name:'ChatGPT',
   request_json:journal.getPreview(path).input,result:JSON.stringify(preview)};
  const summary=detailPresentation(entry,entry.time);
  assert.ok(summary.some(v=>v.section==='STDOUT · 末尾预览'));
  assert.ok(summary.some(v=>v.text.includes('前面已省略')&&v.text.includes('按 o')));
  const pos=summary.findIndex(v=>v.section==='STDOUT · 末尾预览');
  const tail=summary.slice(pos+1).filter(v=>v.sourceLine!==undefined);
  assert.equal(tail.length,0,'tail rows must not advertise incorrect original line numbers');
  const item=detailLines(entry);
  assert.ok(JSON.stringify(item).includes('末尾预览'));
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
  assert.equal(preview.outputPreviewOmittedChars,0);
  assert.equal(preview.outputPreview,'hello');
 }finally{rmSync(dir,{force:true,recursive:true});}
});
