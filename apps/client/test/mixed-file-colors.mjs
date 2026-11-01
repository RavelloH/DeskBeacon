import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDetailSections} from '../dist/detail-preview.js';
import {previewFromEdges} from '@deskbeacon/protocol';
import {numberedPreviewBlock,wrapDetail,sourceLineGutter} from '../dist/detail-presentation.js';

const rowsFor=part=>numberedPreviewBlock(part.preview,part.language,
 part.startLine===undefined?null:part.startLine,undefined,part.sourceText,'o',undefined,part.edgeOmission);

test('multiple source files in the same 4 KiB DETAIL retain independent palettes, titles and line ranges',()=>{
 const blocks=[
  {kind:'output',title:'main.ts',text:'const answer = "hello";\nconsole.log(answer);',language:'typescript',startLine:1},
  {kind:'output',title:'cfg.json',text:'{"ready": true, "count": 42}',language:'json',startLine:31},
  {kind:'output',title:'app.py',text:'def run(): return "done"',language:'python',startLine:16}
 ];
 const [group]=createDetailSections(blocks);
 assert.equal(group.parts.length,3);
 assert.deepEqual(group.parts.map(part=>part.title),['main.ts','cfg.json','app.py']);
 assert.ok(group.parts.every(part=>!part.preview.truncated));
 const rows=group.parts.flatMap(rowsFor);
 const code=rows.filter(row=>typeof row.sourceLine==='number');
 assert.deepEqual(code.map(row=>row.sourceLine),[1,2,31,16]);
 assert.ok(code.every(row=>new Set(row.syntax.map(span=>span.color)).size>1));
 assert.ok(!rows.some(row=>row.gutterLabel==='...'||row.text.includes('已隐藏')));
});

test('internal omission is one inline gutter row with a standardized actionable notice',()=>{
 const lines=Array.from({length:1180},(_,i)=>'line '+(i+1));
 const [group]=createDetailSections([{kind:'output',title:'RUN',text:lines.join('\n'),startLine:1}],512);
 const part=group.parts[0];
 assert.ok(part.preview.truncated);
 const rows=rowsFor(part);
 const marker=rows.filter(row=>row.gutterLabel==='...');
 assert.equal(marker.length,1);
 assert.equal(marker[0].sourceLine,null);
 assert.match(marker[0].text,/^\[已隐藏 \d+ 行 · 按 o 查看完整输出\]$/);
 const hidden=Number(marker[0].text.match(/已隐藏 (\d+) 行/)[1]);
 assert.equal(hidden,part.preview.omittedLines);
 const wrapped=wrapDetail(rows,20);
 assert.equal(wrapped.filter(row=>row.gutterLabel==='...'&&!row.continued).length,1);
 assert.equal(rows.at(-1).sourceLine,1180);
});

test('front-only or tail-only omissions remain edge ellipses',()=>{
 const data=Array.from({length:1000},(_,i)=>'row'+i).join('\n');
 for(const mode of ['head','tail']){
  const ratio=mode==='head'?1:0;
  const preview=previewFromEdges(mode==='head'?data:'',mode==='tail'?data:'',
   Buffer.byteLength(data),512,{headRatio:ratio,totalLines:1000});
  const rows=numberedPreviewBlock(preview,undefined,1);
  assert.equal(rows.filter(row=>row.text==='…').length,1);
  assert.equal(rows.some(row=>row.gutterLabel==='...'),false);
  assert.equal(rows.some(row=>row.text.includes('已隐藏')&&row.gutterLabel==='...'),false);
 }
});

test('two-digit source lines and the three-dot omission share exactly the same gutter separator column',()=>{
 const source=Array.from({length:60},(_,i)=>'value '+(i+1)+' '+'.'.repeat(24)).join('\n');
 const [group]=createDetailSections([{kind:'output',title:'OUTPUT',text:source,startLine:1}],256);
 const rows=rowsFor(group.parts[0]);
 const marker=rows.find(row=>row.gutterLabel==='...');
 assert.ok(marker);
 assert.equal(marker.lineDigits,3);
 const numbered=rows.filter(row=>typeof row.sourceLine==='number');
 assert.ok(numbered.length>0);
 assert.ok(numbered.every(row=>row.lineDigits===3));
 const markerGutter=sourceLineGutter(marker);
 const codeGutters=numbered.map(sourceLineGutter);
 assert.equal(markerGutter,' ... │ ');
 assert.ok(codeGutters.every(gutter=>gutter.indexOf('│')===markerGutter.indexOf('│')));
 assert.ok(codeGutters.every(gutter=>gutter.length===markerGutter.length));
 const wrapped=wrapDetail(rows,23);
 const wrappedMarker=wrapped.filter(row=>row.gutterLabel==='...');
 assert.ok(wrappedMarker.length>=1);
 assert.ok(wrappedMarker.every(row=>sourceLineGutter(row).length===markerGutter.length));
});

test('four-digit source numbers keep four-column gutters and align with the three-dot marker',()=>{
 const source=Array.from({length:1250},(_,i)=>'value '+(i+1)).join('\n');
 const [group]=createDetailSections([{kind:'output',title:'OUTPUT',text:source,startLine:1}],512);
 const rows=rowsFor(group.parts[0]);
 const marker=rows.find(row=>row.gutterLabel==='...');
 assert.ok(marker);
 assert.equal(marker.lineDigits,4);
 assert.equal(sourceLineGutter(marker),'  ... │ ');
 assert.ok(rows.filter(row=>typeof row.sourceLine==='number').every(row=>
  sourceLineGutter(row).indexOf('│')===sourceLineGutter(marker).indexOf('│')));
});

test('middle omission gutter aligns with numeric line numbers at every width',()=>{
 for(const count of [25,125,1180,10000]){
  const source=Array.from({length:count},(_,i)=>'line '+(i+1)+' '+'.'.repeat(35)).join('\n');
  const [group]=createDetailSections([{kind:'output',title:'LOG',text:source,startLine:1}],384);
  const part=group.parts[0];
  assert.equal(part.preview.truncated,true);
  const rows=rowsFor(part);
  const marker=rows.find(item=>item.gutterLabel==='...');
  assert.ok(marker,'missing omission line for '+count);
  const numbered=rows.filter(item=>typeof item.sourceLine==='number');
  assert.equal(numbered.at(-1)?.sourceLine,count);
  const separatorColumns=new Set([...numbered,marker].map(item=>sourceLineGutter(item).indexOf('│')));
  assert.equal(separatorColumns.size,1,'separator shifted for '+count+' lines');
  assert.equal(sourceLineGutter(marker).length,sourceLineGutter(numbered[0]).length);
  assert.equal(marker.lineDigits,Math.max(3,String(count).length));
  const wrapped=wrapDetail(rows,28);
  const wrappedGutters=new Set(wrapped.filter(item=>item.sourceLine!==undefined).map(item=>sourceLineGutter(item).indexOf('│')));
  assert.deepEqual([...wrappedGutters],[separatorColumns.values().next().value],
   'soft-wrap separator shifted for '+count+' lines');
 }
});
