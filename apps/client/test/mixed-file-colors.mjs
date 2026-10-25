import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDetailSections} from '../dist/detail-preview.js';
import {previewFromEdges} from '@deskbeacon/protocol';
import {numberedPreviewBlock,wrapDetail,sourceLineGutter} from '../dist/detail-presentation.js';

test('multiple source files in the same 4 KiB DETAIL retain their own language palettes and line ranges',()=>{
 const blocks=[
  {kind:'output',title:'main.ts',text:'const answer = "hello";\nconsole.log(answer);',language:'typescript',startLine:1},
  {kind:'output',title:'cfg.json',text:'{"ready": true, "count": 42}',language:'json',startLine:31},
  {kind:'output',title:'app.py',text:'def run(): return "done"',language:'python',startLine:16}
 ];
 const [group]=createDetailSections(blocks);
 assert.ok(group.sourceStyled);
 assert.equal(group.preview.truncated,false);
 const rows=numberedPreviewBlock(group.preview,group.language,group.startLine??null,
  group.lineMap,group.sourceText,'o',group.sourceStyled);
 const code=rows.filter(x=>typeof x.sourceLine==='number');
 assert.deepEqual(code.map(x=>x.sourceLine),[1,2,31,16]);
 assert.ok(code.every(row=>new Set(row.syntax.map(s=>s.color)).size>1));
 assert.ok(!rows.some(r=>r.gutterLabel==='...'||r.text.includes('已隐藏')));
});

test('internal omission is a single numbered code line and wraps without inventing a new number',()=>{
 const lines=Array.from({length:1180},(_,i)=>'line '+(i+1));
 const [group]=createDetailSections([{kind:'output',title:'RUN',text:lines.join('\n'),startLine:1}],512);
 const rows=numberedPreviewBlock(group.preview,undefined,group.startLine??1,
  group.lineMap,group.sourceText,'o',group.sourceStyled);
 const marker=rows.filter(x=>x.gutterLabel==='...');
 assert.equal(marker.length,1);
 assert.equal(marker[0].sourceLine,null);
 assert.match(marker[0].text,/^已隐藏 \d+ 行，按 o 展开$/);
 const hidden=Number(marker[0].text.match(/\d+/)[0]);
 assert.equal(hidden,group.preview.tailStartLine-group.preview.headLines-1);
 const wrapped=wrapDetail(rows,20);
 assert.equal(wrapped.filter(x=>x.gutterLabel==='...'&&!x.continued).length,1);
 assert.equal(rows.at(-1).sourceLine,1180);
});

test('front-only or tail-only omissions remain edge ellipses',()=>{
 const data=Array.from({length:1000},(_,i)=>'row'+i).join('\n');
 for(const mode of ['head','tail']){
  const ratio=mode==='head'?1:0;
  const preview=previewFromEdges(mode==='head'?data:'',mode==='tail'?data:'',
   Buffer.byteLength(data),512,{headRatio:ratio,totalLines:1000});
  const rows=numberedPreviewBlock(preview,undefined,1);
  assert.equal(rows.filter(r=>r.text==='…').length,1);
  assert.equal(rows.some(r=>r.gutterLabel==='...'),false);
 }
});

test('two-digit source lines and the three-dot omission share exactly the same gutter separator column',()=>{
 const source=Array.from({length:60},(_,i)=>'value '+(i+1)+' '+'.'.repeat(24)).join('\n');
 const [group]=createDetailSections([{kind:'output',title:'OUTPUT',text:source,startLine:1}],256);
 const rows=numberedPreviewBlock(group.preview,undefined,1,group.lineMap,group.sourceText);
 const marker=rows.find(x=>x.gutterLabel==='...');
 assert.ok(marker);
 assert.equal(marker.lineDigits,3);
 const numbered=rows.filter(x=>typeof x.sourceLine==='number');
 assert.ok(numbered.length>0);
 assert.ok(numbered.every(x=>x.lineDigits===3));
 const markerGutter=sourceLineGutter(marker);
 const codeGutters=numbered.map(sourceLineGutter);
 assert.equal(markerGutter,' ... │ ');
 assert.ok(codeGutters.every(g=>g.indexOf('│')===markerGutter.indexOf('│')));
 assert.ok(codeGutters.every(g=>g.length===markerGutter.length));
 const wrapped=wrapDetail(rows,23);
 const wrappedMarker=wrapped.filter(x=>x.gutterLabel==='...');
 assert.ok(wrappedMarker.length>=1);
 assert.ok(wrappedMarker.every(x=>sourceLineGutter(x).length===markerGutter.length));
});
test('four-digit source numbers keep four-column gutters and still align with the three-dot marker',()=>{
 const source=Array.from({length:1250},(_,i)=>'value '+(i+1)).join('\n');
 const [group]=createDetailSections([{kind:'output',title:'OUTPUT',text:source,startLine:1}],512);
 const rows=numberedPreviewBlock(group.preview,undefined,1,group.lineMap,group.sourceText);
 const marker=rows.find(x=>x.gutterLabel==='...');
 assert.ok(marker);
 assert.equal(marker.lineDigits,4);
 assert.equal(sourceLineGutter(marker),'  ... │ ');
 assert.ok(rows.filter(x=>typeof x.sourceLine==='number').every(x=>
  sourceLineGutter(x).indexOf('│')===sourceLineGutter(marker).indexOf('│')));
});
