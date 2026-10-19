import assert from 'node:assert/strict';
import {inspectorInput,inspectorResult,inspectorOutput,inspectorCopyText} from '../dist/detail-inspector.js';
import {wrapDetail,numberedBlock,fullNumberedBlock} from '../dist/detail-presentation.js';
const source=Array.from({length:410},(_,i)=>'echo LINE_'+(i+1)).join('\n');
const entry={id:'demo',tool:'exec_foreground',request_json:JSON.stringify({
 command:{mode:'shell',shellProfile:'pwsh',script:source},cwd:'E:\\test'})};
const input=inspectorInput(entry,{text:entry.request_json,totalBytes:entry.request_json.length,available:true});
assert.ok(input.some(x=>x.text==='COMMAND · pwsh'));
const completeAt=input.findIndex(x=>x.section==='COMPLETE INPUT · JSON');
assert.ok(completeAt>=0,'INPUT must have a clearly labeled full parameter view');
const completeText=input.slice(completeAt+1).filter(x=>x.sourceLine!==undefined).map(x=>x.text).join('\n');
const completeParams=JSON.parse(completeText);
assert.equal(completeParams.command.script,source,'complete input JSON must preserve shell command');
assert.equal(completeParams.command.shellProfile,'pwsh');
assert.equal(completeParams.cwd,'E:\\test');
const programInput={command:{mode:'program',program:'node.exe',args:['-e','console.log("中文");']},timeoutMs:1000};
const programRows=inspectorInput(entry,{text:JSON.stringify(programInput),
 totalBytes:100,available:true});
const programAt=programRows.findIndex(x=>x.section==='COMPLETE INPUT · JSON');
const programJson=JSON.parse(programRows.slice(programAt+1).filter(x=>x.sourceLine!==undefined).map(x=>x.text).join('\n'));
assert.deepEqual(programJson,programInput,'program and args are part of the complete input');
const writeInput={path:'test.txt',mode:'create',content:'data\\nrest'};
const writeRows=inspectorInput(entry,{text:JSON.stringify(writeInput),totalBytes:60,available:true});
const writeAt=writeRows.findIndex(x=>x.section==='COMPLETE INPUT · JSON');
assert.deepEqual(JSON.parse(writeRows.slice(writeAt+1).filter(x=>x.sourceLine!==undefined).map(x=>x.text).join('\n')),
 writeInput,'file content and all parameters must remain in complete JSON');
assert.equal(input.filter(x=>x.sourceLine!==undefined).length>410,true);
assert.ok(input.some(x=>x.syntax?.some(y=>y.color!=='#969696')),'PowerShell should be syntax highlighted');
assert.ok(!input.some(x=>x.text.includes('... +')),'full input must not use summary cap');
const resultPayload={data:{content:source,lineOffset:310,readBytes:source.length}};
const readEntry={...entry,tool:'fs_read',request_json:JSON.stringify({path:'test.ts',lineOffset:310}),
 result:JSON.stringify({data:{content:'truncated'}})};
const fullResult=inspectorResult(readEntry,{text:JSON.stringify(resultPayload),
 totalBytes:source.length,available:true});
assert.ok(fullResult.some(line=>line.section==='FILE CONTENT'));
assert.deepEqual(fullResult.filter(line=>line.section===undefined&&line.sourceLine!==undefined)
 .slice(0,3).map(line=>line.sourceLine),[311,312,313],
 'full o inspector must show file read result with original line numbers');
assert.ok(fullResult.length>410,'o must show the complete 410-line file rather than DB preview');
assert.ok(fullResult.some(line=>line.section==='COMPLETE RESULT · JSON'));
assert.equal(inspectorCopyText('result',readEntry,{text:JSON.stringify(resultPayload),
 totalBytes:20,available:true}),JSON.stringify(resultPayload));
assert.ok(inspectorResult(readEntry,{text:'',totalBytes:0,available:false})
 .some(line=>line.text.includes('无法恢复')),'unavailable historical source must never claim full expansion');
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
assert.ok(summary.at(-1).text.includes('(按 o 展开)'),'result preview should point to the actual o key');
assert.ok(summary.at(-1).text.includes('行'),'preview must count omitted lines');
const lengthLimited=numberedBlock('z'.repeat(1200),undefined,1,10,400);
assert.ok(lengthLimited.some(x=>x.text.includes('... +0 行, 800 字符 (按 o 展开)')));
assert.ok(!numberedBlock('a\r\nb\r\n',undefined,1,10,1000).some(x=>x.text.includes('...剩余')),
 'CRLF normalization must not invent truncation');
const beyondCharCap=numberedBlock('first\nsecond\nthird\nfourth',undefined,1,20,8);
assert.ok(beyondCharCap.at(-1).text.includes('2 行'),
 'line remainder must include newlines beyond the character cap');
const inputLimited=numberedBlock('x'.repeat(650),undefined,1,10,1000,'i');
assert.ok(inputLimited.at(-1).text.includes('... +0 行, 150 字符 (按 i 展开)'));
const lineLimited=numberedBlock('x'.repeat(650),undefined,1,10,1000);
assert.equal(lineLimited.at(-1).text,'... +0 行, 150 字符 (按 o 展开)',
 'per-line 500 character cut must be included in the total footer count');
const wraps=wrapDetail(fullNumberedBlock('12345678901234567890\nshort'),12);
assert.ok(wraps.some(x=>x.continued),'long logical line must soft wrap');
assert.equal(inspectorCopyText('input',entry,{text:'complete',totalBytes:8,available:true}),'complete');
assert.equal(inspectorCopyText('stdout',entry,{text:source,totalBytes:100,available:true}),source);
assert.ok(inspectorInput(entry,{text:'',totalBytes:0,available:false}).some(x=>x.text.includes('旧版历史')));
assert.equal(inspectorOutput({text:'{"ok":true}',totalBytes:11,available:true},'stdout').some(x=>x.syntax!==undefined),true);
console.log('PASS complete input/output, syntax, copy and truncation accounting');
