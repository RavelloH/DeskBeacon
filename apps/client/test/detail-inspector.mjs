import assert from 'node:assert/strict';
import {inspectorInput,inspectorOutput,inspectorCopyText} from '../dist/detail-inspector.js';
import {wrapDetail,numberedBlock,fullNumberedBlock} from '../dist/detail-presentation.js';
const source=Array.from({length:410},(_,i)=>'echo LINE_'+(i+1)).join('\n');
const entry={id:'demo',tool:'exec_foreground',request_json:JSON.stringify({
 command:{mode:'shell',shellProfile:'pwsh',script:source},cwd:'E:\\test'})};
const input=inspectorInput(entry,{text:entry.request_json,totalBytes:entry.request_json.length,available:true});
assert.ok(input.some(x=>x.text==='COMMAND · pwsh'));
assert.equal(input.filter(x=>x.sourceLine!==undefined).length>410,true);
assert.ok(input.some(x=>x.syntax?.some(y=>y.color!=='#969696')),'PowerShell should be syntax highlighted');
assert.ok(!input.some(x=>x.text.includes('...剩余')),'full input must not use summary cap');
const longCode='const total = 42;\n'.repeat(1900);
const longHighlighted=fullNumberedBlock(longCode,'typescript');
assert.ok(longHighlighted.some(row=>row.syntax?.some(span=>span.color!=='#969696')),
 'code above 20k characters must preserve syntax highlighting');
assert.equal(longHighlighted.map(x=>x.text).join('\n'),longCode,
 'highlight chunk boundaries must preserve exact source text');
const logs=inspectorOutput({text:source,totalBytes:Buffer.byteLength(source),available:true},'stdout');
assert.ok(logs.length>=410,'complete stdout should not stop at 280 lines');
assert.ok(inspectorOutput({text:'partial',totalBytes:7,available:true},'stderr',undefined,true)
 .some(x=>x.text.includes('缺失字符数无法确定')),
 'executor-level output truncation must be explicit even when the missing count is unknowable');
const summary=numberedBlock(source,'powershell',1,20,1000);
assert.ok(summary.at(-1).text.includes('...剩余'),'preview must explicitly report omitted line count');
assert.ok(summary.at(-1).text.includes('行'),'preview must count omitted lines');
const lengthLimited=numberedBlock('z'.repeat(1200),undefined,1,10,400);
assert.ok(lengthLimited.some(x=>x.text.includes('...剩余 800 字符')));
assert.ok(!numberedBlock('a\r\nb\r\n',undefined,1,10,1000).some(x=>x.text.includes('...剩余')),
 'CRLF normalization must not invent truncation');
const lineLimited=numberedBlock('x'.repeat(650),undefined,1,10,1000);
assert.ok(lineLimited[0].text.includes('...剩余 150 字符'),'long single lines must report trimmed characters');
const wraps=wrapDetail(fullNumberedBlock('12345678901234567890\nshort'),12);
assert.ok(wraps.some(x=>x.continued),'long logical line must soft wrap');
assert.equal(inspectorCopyText('input',entry,{text:'complete',totalBytes:8,available:true}),'complete');
assert.equal(inspectorCopyText('stdout',entry,{text:source,totalBytes:100,available:true}),source);
assert.ok(inspectorInput(entry,{text:'',totalBytes:0,available:false}).some(x=>x.text.includes('旧版历史')));
assert.equal(inspectorOutput({text:'{"ok":true}',totalBytes:11,available:true},'stdout').some(x=>x.syntax!==undefined),true);
console.log('PASS complete input/output, syntax, copy and truncation accounting');
