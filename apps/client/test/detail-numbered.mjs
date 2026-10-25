import assert from 'node:assert/strict';
import {detailPresentation,numberedBlock,wrapDetail} from '../dist/detail-presentation.js';
const text='first line is long enough for terminal wrapping\nsecond\nthird';
const plain=numberedBlock(text,undefined,311);
assert.deepEqual(plain.map(x=>x.sourceLine),[311,312,313]);
const wrapped=wrapDetail(plain,17);
assert.equal(wrapped[0].sourceLine,311);
assert.ok(wrapped.some(x=>x.sourceLine===311&&x.continued));
assert.ok(wrapped.filter(x=>x.sourceLine===311&&x.continued).every(x=>x.lineDigits===3),
 'soft-wrapped source rows retain width but render no extra line-number glyph');
const digits=numberedBlock('a\nb\nc',undefined,998);
assert.deepEqual(digits.map(item=>item.lineDigits),[4,4,4],
 'gutter width must accommodate the largest source line number without a five-cell minimum');
assert.ok(wrapped.some(x=>x.sourceLine===312&&!x.continued));
assert.equal(numberedBlock('unknown\nline',undefined,null)[0]?.sourceLine,null);
const entry={id:'test',grant_id:'grant',actor_name:'ChatGPT',tool:'fs_read',status:'completed',
 time:Date.now(),description:'read',request_json:JSON.stringify({path:'/tmp/a.ts',lineOffset:310}),
 result:JSON.stringify({data:{content:'hello\nworld',linesRead:2,readBytes:11,lineOffset:310}})};
const detail=detailPresentation(entry,entry.time);
assert.deepEqual(detail.filter(x=>x.sourceLine!==undefined).map(x=>x.sourceLine),[311,312]);
const multi={...entry,tool:'fs_read_many',
 request_json:JSON.stringify({files:[{path:'/tmp/a.ts',lineOffset:319}]}),
 result:JSON.stringify({data:{files:[{path:'/tmp/a.ts',lineOffset:319,content:'x\ny'}]}})};
assert.deepEqual(detailPresentation(multi,multi.time).filter(x=>x.sourceLine!==undefined).map(x=>x.sourceLine),[320,321]);
const bytes={...entry,request_json:JSON.stringify({path:'/tmp/a.ts',byteOffset:50}),result:JSON.stringify({data:{content:'line'}})};
assert.equal(detailPresentation(bytes,bytes.time).find(x=>x.sourceLine!==undefined)?.sourceLine,undefined,
 'unknown byte offsets have no source line number gutter');
console.log('PASS numbered logical lines, continuation gutters, nonzero file read ranges and unknown byte-offset line numbers');
