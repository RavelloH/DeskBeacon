import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordJournal} from '../dist/record-journal.js';
import {fileTool} from '../dist/filesystem.js';
import {inspectorResult} from '../dist/detail-inspector.js';
import {detailPresentation} from '../dist/detail-presentation.js';
import {createDetailSections} from '../dist/detail-preview.js';

test('fs_edit retains the real applied diff in OUTPUT and bounds Agent preview',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'db-real-diff-'));
 try{
  const file=join(dir,'sample.txt'),journal=new RecordJournal(join(dir,'journal'));
  const original='START\n'+Array.from({length:2600},(_,i)=>'value'+i+'=old\n').join('')+'END\n';
  writeFileSync(file,original);
  const request={path:file,mode:'replace',oldText:'=old',newText:'=new',
   expectedReplacements:2600,dryRun:false};
  const id='edit-real',path=journal.start(id,'fs_edit',request);
  const result=await fileTool('fs_edit',request,undefined,diff=>journal.stream(id,'diff',Buffer.from(diff,'utf8')));
  journal.finish(id,result,'completed');
  assert.equal(result.changed,true);
  assert.equal(result.diffStored,true);
  assert.equal(result.diffTruncated,true);
  assert.ok(result.diffBytes>8192);
  assert.match(readFileSync(file,'utf8'),/value2599=new/);
  const data=journal.getRecordStream(path,'diff',0,1_048_576);
  assert.equal(data.hasMore,false);
  assert.equal(data.totalBytes,result.diffBytes);
  assert.match(data.text,/value0=new/);
  assert.match(data.text,/value2599=new/);
  const entry={id,tool:'fs_edit',request_json:JSON.stringify(request),result:JSON.stringify(result),
   grant_id:'g',description:'edit',status:'completed',time:Date.now()};
  const view=inspectorResult(entry,{text:data.text,totalBytes:data.totalBytes,available:true});
  assert.ok(view.some(row=>row.section==='DIFF · OUTPUT'),JSON.stringify({start:data.text.slice(0,90),headings:view.filter(v=>v.section).map(v=>v.section)}));
  assert.ok(!view.some(row=>row.section==='COMPLETE RESULT · JSON'));
  const d=detailPresentation(entry,Date.now());
  assert.ok(d.some(row=>row.section==='OUTPUT'));
  assert.ok(d.some(row=>row.gutterLabel==='...'&&row.text.includes('已隐藏')&&row.text.includes('按 o 展开')));
  assert.ok(!d.some(row=>row.text.startsWith('预览已省略')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('4 KiB is shared across all DETAILS input/output, without list item limits',()=>{
 const input='INPUT_BEGIN\n'+'A'.repeat(12000)+'\nINPUT_END';
 const output='OUTPUT_BEGIN\n'+'Z'.repeat(15000)+'\nOUTPUT_END';
 const groups=createDetailSections([
  {kind:'input',title:'write',text:input,preference:'balanced'},
  {kind:'output',title:'diff',text:output,preference:'balanced'}
 ]);
 assert.equal(groups.length,2);
 const bytes=groups.reduce((sum,g)=>sum+Buffer.byteLength(g.preview.text),0);
 assert.ok(bytes<=4096,'preview bytes '+bytes);
 assert.ok(groups.every(g=>g.preview.truncated));
 assert.ok(groups[0].preview.text.includes('INPUT_BEGIN'));
 assert.ok(groups[1].preview.text.includes('OUTPUT_END'));
 const tiny=createDetailSections([
  {kind:'input',title:'tiny',text:'a'},
  {kind:'output',title:'huge',text:'Z'.repeat(15000)}
 ]);
 assert.ok(tiny.reduce((v,g)=>v+Buffer.byteLength(g.preview.text),0)<=4096);
 const many=Array.from({length:180},(_,i)=>'match '+i).join('\n');
 const list=createDetailSections([{kind:'output',title:'entries',text:many,preference:'head'}]);
 assert.equal(list[0].preview.truncated,false);
 assert.ok(list[0].preview.text.includes('match 179'));
});
