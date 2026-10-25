import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSelectedOutputPreview} from '../dist/selected-output-preview.js';

const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const fixture=(value)=>{
 const bytes=enc.encode(value),calls=[];
 return {calls,fetch:async ({byteOffset,maxBytes})=>{
  calls.push([byteOffset,maxBytes]);
  if(byteOffset>0&&(bytes[byteOffset]&0xc0)===0x80)throw Error('INVALID_BYTE_OFFSET');
  let end=Math.min(bytes.length,byteOffset+maxBytes);
  while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  const text=dec.decode(bytes.subarray(byteOffset,end));
  return {text,totalBytes:bytes.length,nextOffset:end,available:true};
 }};
};
test('selected stdout preview reads only two small pages of a large log',async()=>{
 const input='BEGIN\n'+('line-内容🚀\n'.repeat(12000))+'END\n';
 const f=fixture(input);
 const result=await loadSelectedOutputPreview('operation1',f.fetch);
 assert.ok(result);
 assert.equal(result.strategy,'result_priority');
 assert.ok(result.truncated);
 assert.ok(result.text.startsWith('BEGIN'));
 assert.ok(result.text.endsWith('END\n'));
 assert.ok(enc.encode(result.text).length<=4096);
 assert.ok(f.calls.length<=6);
 assert.ok(f.calls.every(([,size])=>size===4096));
});
test('short stdout is unchanged without a tail lookup',async()=>{
 const input='header\nbody🚀\n';
 const f=fixture(input),result=await loadSelectedOutputPreview('short',f.fetch);
 assert.ok(result);
 assert.equal(result.text,input);
 assert.equal(result.truncated,false);
 assert.deepEqual(f.calls,[[0,4096]]);
});
test('no retained source returns null and keeps legacy summary fallback',async()=>{
 const result=await loadSelectedOutputPreview('unknown',async()=>({
  text:'',totalBytes:0,nextOffset:0,available:false
 }));
 assert.equal(result,null);
});

test('a source-level output limit is distinct from preview truncation',async()=>{
 const input='line' .repeat(3000);
 const f=fixture(input);
 const result=await loadSelectedOutputPreview('limited',f.fetch,4096,false);
 assert.ok(result);
 assert.equal(result.hasFullOutput,false);
 assert.equal(result.truncated,true);
 assert.equal(result.reason,'preview_budget');
});


test('fs_edit RESULT preview reads from existing result route, not stdout',async()=>{
 const diff='Index: edited.ts\n'+'--- before\n'+'+++ after\n'+
  Array.from({length:2000},(_,i)=>'+'+String(i)+' changed\n').join('');
 const f=fixture(diff);
 const actions=[];
 const preview=await loadSelectedOutputPreview('fileedit',async request=>{
  actions.push(request);
  return f.fetch(request);
 },4096,true,'result');
 assert.ok(preview);
 assert.equal(preview.truncated,true);
 assert.ok(preview.text.startsWith('Index: edited.ts'));
 assert.ok(preview.text.endsWith('1999 changed\n'));
 assert.ok(actions.length>=2);
 assert.ok(actions.every(request=>request.action==='result'&&!('stream' in request)));
});
