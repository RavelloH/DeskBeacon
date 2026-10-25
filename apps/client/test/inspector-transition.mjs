import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AtomicInspectorSwitch} from '../dist/inspector-transition.js';
import {createDetailSections} from '../dist/detail-preview.js';
import {numberedPreviewBlock} from '../dist/detail-presentation.js';
import {inspectorOutput} from '../dist/detail-inspector.js';

function deferred(){
 let resolve;
 const promise=new Promise(done=>{resolve=done;});
 return{promise,resolve};
}
test('I/O tab remains stable until the requested stream finishes and stale responses never take over',async()=>{
 const control=new AtomicInspectorSwitch();
 const slow=deferred(),fast=deferred();
 const shown=[];
 const first=control.show('1|task|input',()=>slow.promise,v=>shown.push('INPUT '+v.text),
  error=>assert.fail(String(error)));
 assert.deepEqual(shown,[],'no loading placeholder or provisional view');
 const second=control.show('1|task|result',()=>fast.promise,v=>shown.push('RESULT '+v.text),
  error=>assert.fail(String(error)));
 fast.resolve({text:'diff',totalBytes:4});
 await second;
 assert.deepEqual(shown,['RESULT diff']);
 slow.resolve({text:'request',totalBytes:7});
 await first;
 assert.deepEqual(shown,['RESULT diff'],'old response cannot replace newer view');
 await control.show('1|task|result',()=>{throw Error('should hit cache');},
  v=>shown.push('RESULT '+v.text),error=>assert.fail(String(error)));
 assert.deepEqual(shown,['RESULT diff','RESULT diff']);
 const cancelled=deferred();
 const running=control.show('1|task|input',()=>cancelled.promise,
  ()=>assert.fail('cancelled response committed'),()=>assert.fail('cancelled error'));
 control.cancel();
 cancelled.resolve({text:'cancelled',totalBytes:9});
 await running;
});

test('multiple source files preserve their independent line numbers, even with a truncated group',()=>{
 const a=Array.from({length:80},(_,i)=>'A-'+i).join('\n');
 const b=Array.from({length:80},(_,i)=>'B-'+i).join('\n');
 const [group]=createDetailSections([
  {kind:'output',title:'a.ts',text:a,startLine:1},
  {kind:'output',title:'b.ts',text:b,startLine:1178}
 ],512);
 assert.ok(group.preview.truncated);
 const lines=numberedPreviewBlock(group.preview,undefined,null,group.lineMap);
 const numbers=lines.map(line=>line.sourceLine).filter(n=>typeof n==='number');
 assert.equal(numbers[0],1);
 assert.equal(numbers.at(-1),1257);
 assert.ok(numbers.includes(1178)||numbers.some(n=>n>1178),'the second file uses its own range');
 assert.ok(lines.some(line=>line.gutterLabel==='...'&&line.text.includes('已隐藏')));
});
test('full command output always numbers actual logical lines; no truncation marker when complete',()=>{
 const source=Array.from({length:1180},(_,i)=>'line'+(i+1)).join('\n');
 const rows=inspectorOutput({text:source,totalBytes:Buffer.byteLength(source),available:true},'stdout');
 const numbers=rows.map(v=>v.sourceLine).filter(n=>typeof n==='number');
 assert.deepEqual(numbers.slice(0,3),[1,2,3]);
 assert.deepEqual(numbers.slice(-3),[1178,1179,1180]);
 assert.equal(rows.some(v=>v.text==='…'||v.text.includes('已省略')),false);
});
