import assert from 'node:assert/strict';
import {readEntireLocalStream} from '../dist/local-stream.js';
const text='Hello 中文 👋\n'.repeat(8000),data=Buffer.from(text,'utf8');
const unit=Buffer.byteLength('Hello 中文 👋\n');
const boundaries=[0,unit*3000,unit*6000,data.length];
const reads=[];
const result=await readEntireLocalStream(async offset=>{
 reads.push(offset);
 const end=boundaries.find(n=>n>offset)??data.length;
 const value=data.subarray(offset,end).toString('utf8');
 return {text:value,nextOffset:end,totalBytes:data.length,hasMore:end<data.length,stream:'stdout'};
});
assert.equal(result.text,text);
assert.equal(result.totalBytes,data.length);
assert.ok(reads.length>1,'large output must load multiple pages');
const lost=await readEntireLocalStream(async()=>({text:'',nextOffset:0,totalBytes:0,hasMore:false,stream:'input',available:false}));
assert.equal(lost.available,false);
await assert.rejects(()=>readEntireLocalStream(async()=>({text:'',nextOffset:0,totalBytes:20,hasMore:true,stream:'stdout'})),/STALLED/);
console.log('PASS full local source over multiple pages, unknown legacy input and stalled reader detection');
