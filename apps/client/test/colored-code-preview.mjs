import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPreview} from '@deskbeacon/protocol';
import {styleTerminalSource,detectOutputLanguage} from '../dist/terminal-highlight.js';
import {numberedBlock,numberedPreviewBlock,detailPresentation,wrapDetail} from '../dist/detail-presentation.js';
import {inspectorOutput,inspectorInput} from '../dist/detail-inspector.js';

const flatten=row=>(row.syntax??[]).map(span=>span.text).join('');
test('native ANSI red/green and RGB colors survive through the whole stdout/stderr inspector',()=>{
 const raw='\x1b[31mFAIL\nSTILL RED\x1b[0m now normal\n\x1b[38;2;11;120;230mBLUE\x1b[39m';
 const styled=styleTerminalSource(raw);
 assert.deepEqual(styled.lines,['FAIL','STILL RED now normal','BLUE']);
 assert.equal(styled.spans[0][0].color,'#C66D78');
 assert.equal(styled.spans[1][0].color,'#C66D78');
 assert.equal(styled.spans[1].at(-1).color,'#969696');
 assert.equal(styled.spans[2][0].color,'#0b78e6');
 const out=inspectorOutput({text:raw,totalBytes:Buffer.byteLength(raw),available:true},'stdout');
 assert.deepEqual(out.map(x=>x.sourceLine),[1,2,3]);
 assert.equal(out.some(x=>x.text.includes('\x1b')),false);
 assert.equal(out[0].syntax[0].color,'#C66D78');
 const err=inspectorOutput({text:raw,totalBytes:Buffer.byteLength(raw),available:true},'stderr');
 assert.equal(err[2].syntax[0].color,'#0b78e6');
});

test('auto-highlight JSON and JSONL outputs, including input JSON and diff',()=>{
 const jsonl='{"status":"ok","count":12}\n{"status":"error","count":3}';
 assert.equal(detectOutputLanguage(jsonl),'json');
 const result=inspectorOutput({text:jsonl,totalBytes:Buffer.byteLength(jsonl),available:true},'stdout');
 assert.equal(result.length,2);
 assert.ok(result[0].syntax.length>1);
 assert.ok(new Set(result[0].syntax.map(s=>s.color)).size>1);
 const diff=numberedBlock('--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new','diff');
 assert.ok(diff.some(row=>row.syntax.some(span=>span.color==='#9ED1A3')));
 const input={command:{mode:'shell',script:'echo 123'},content:'{"ok": true}',mode:'rewrite',path:'hello.json'};
 const entry={id:'input',tool:'fs_write',description:'write',grant_id:'g',status:'completed',time:Date.now(),
  request_json:JSON.stringify(input),result:'{}'};
 const full=inspectorInput(entry,{text:JSON.stringify(input),available:true,totalBytes:99});
 assert.ok(full.some(row=>row.section==='FILE CONTENT'));
 assert.ok(full.some(row=>row.section==='COMPLETE INPUT · JSON'));
 assert.ok(full.filter(row=>row.sourceLine!==undefined&&row.syntax).some(row=>new Set(row.syntax.map(x=>x.color)).size>1));
});

test('highlight full multiline source before preview cropping; tail retains real original color',()=>{
 const source='/* start\n'+('a'.repeat(40)+'\n').repeat(400)+
  'this is still in a comment\n */\nconst value = "ok";\n';
 const complete=numberedBlock(source,'typescript',1,Infinity,Infinity);
 const preview=createPreview(source,1024);
 const excerpt=numberedPreviewBlock(preview,'typescript',1,undefined,source);
 assert.ok(preview.truncated);
 const lastComment=excerpt.find(row=>row.text==='this is still in a comment');
 const sameComplete=complete.find(row=>row.text==='this is still in a comment');
 assert.ok(lastComment&&sameComplete);
 assert.deepEqual(lastComment.syntax,sameComplete.syntax);
 assert.ok(excerpt.some(row=>row.gutterLabel==='...'&&row.text.includes('已隐藏')&&row.text.includes('按 o 展开')));
 const gap=excerpt.find(row=>row.gutterLabel==='...');
 assert.equal(gap.sourceLine,null);
 assert.equal(gap.lineDigits,String(preview.totalLines).length);
 assert.deepEqual(excerpt.filter(row=>typeof row.sourceLine==='number').slice(-2).map(row=>row.sourceLine),
  [preview.totalLines-1,preview.totalLines]);
 const wrapped=wrapDetail(excerpt,36);
 assert.equal(wrapped.filter(x=>x.gutterLabel==='...'&&!x.continued).length,1);
});

test('APPENDED CONTENT and other text previews show code highlighting and relative line numbers',()=>{
 const request={path:'app.py',mode:'append',content:'def main():\n    print("ok")'};
 const entry={id:'append',tool:'fs_write',request_json:JSON.stringify(request),
  description:'write',grant_id:'g',status:'completed',time:Date.now(),result:'{"writtenBytes":22}'};
 const rows=detailPresentation(entry,Date.now());
 assert.ok(rows.some(row=>row.text==='APPENDED CONTENT'));
 const code=rows.filter(row=>typeof row.sourceLine==='number');
 assert.deepEqual(code.map(row=>row.sourceLine),[1,2]);
 assert.ok(code.some(row=>new Set(row.syntax.map(span=>span.color)).size>1));
});

test('never manufacture an omission notice on complete output',()=>{
 const v=numberedBlock('line one\nline two','bash',1,Infinity,Infinity);
 assert.ok(!v.some(x=>x.gutterLabel==='...'||/已隐藏|已省略/.test(x.text)));
});
