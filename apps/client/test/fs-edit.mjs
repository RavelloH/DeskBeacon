import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createPatch} from 'diff';
import {fileTool} from '../dist/filesystem.js';
import {toolInputSchemas} from '../../../packages/protocol/dist/tools.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-fs-edit-'));
const file=join(root,'editable.ts');
const digest=s=>createHash('sha256').update(Buffer.from(s)).digest('hex');
async function edit(input){return fileTool('fs_edit',toolInputSchemas.fs_edit.parse({deviceId:'test',path:file,...input}));}
function write(text){writeFileSync(file,text,'utf8');}
function read(){return readFileSync(file,'utf8');}
try{
 write('first\r\nconst before=1;\r\nlast\r\n');
 let result=await edit({mode:'replace',oldText:'first\nconst before=1;\n',
  newText:'first\nconst after=2;\n'});
 assert.equal(read(),'first\r\nconst after=2;\r\nlast\r\n');
 assert.equal(result.normalizedEol,true);
 assert.equal(result.replacements,1);
 assert.equal(result.dryRun,false);
 console.log('PASS CRLF file accepts LF edit and preserves CRLF');

 write('alpha\nbeta\ngamma\n');
 result=await edit({mode:'replace',oldText:'alpha\r\nbeta\r\n',
  newText:'first\r\nsecond\r\n'});
 assert.equal(read(),'first\nsecond\ngamma\n');
 assert.equal(result.normalizedEol,true);
 console.log('PASS LF file accepts CRLF edit without converting unrelated lines');

 write('before\r\nmatch\nmore\r\ntail\n');
 result=await edit({mode:'replace',oldText:'match\nmore',newText:'changed\nagain'});
 assert.equal(read(),'before\r\nchanged\nagain\r\ntail\n');
 assert.equal(result.normalizedEol,false);
 console.log('PASS mixed line endings outside edit remain byte-for-byte unchanged');

 write('one\r\ntwo\r\nthree\r\n');
 result=await edit({mode:'replace',oldText:'two',newText:'two\nextra'});
 assert.equal(read(),'one\r\ntwo\r\nextra\r\nthree\r\n');
 console.log('PASS newly inserted lines adopt existing CRLF');

 write('same\r\nend\r\nsame\r\nend\r\n');
 const ambiguous=read();
 await assert.rejects(()=>edit({mode:'replace',oldText:'same\nend',newText:'changed'}),
  error=>error.message.includes('REPLACEMENT_COUNT_MISMATCH')&&
    error.message.includes('normalized=2')&&error.message.includes('expected=1')&&
    error.message.includes('fileEOL=CRLF'));
 assert.equal(read(),ambiguous,'ambiguous matches must not write');
 result=await edit({mode:'replace',oldText:'same\nend',newText:'changed',expectedReplacements:2});
 assert.equal(read(),'changed\r\nchanged\r\n');
 assert.equal(result.replacements,2);
 console.log('PASS ambiguous EOL-equivalent edits fail safely; explicit multi-match succeeds');

 write('head\r\nA\r\nB\r\ntail\r\n');
 const original=read();
 result=await edit({mode:'replace_many',dryRun:true,replacements:[
  {oldText:'A',newText:'changed-A'},{oldText:'B',newText:'changed-B'}]});
 assert.equal(read(),original,'dry-run must not modify the file');
 assert.equal(result.replacements,2);
 assert.equal(result.changed,true);
 assert.equal(result.dryRun,true);
 const bad=[
  {oldText:'A',newText:'changed-A'},{oldText:'this portion does not exist',newText:'oops'}
 ];
 await assert.rejects(()=>edit({mode:'replace_many',replacements:bad}),
  /REPLACEMENT_COUNT_MISMATCH/);
 assert.equal(read(),original,'all edits must validate before a single atomic write');
 result=await edit({mode:'replace_many',replacements:[
  {oldText:'A',newText:'changed-A'},{oldText:'B',newText:'changed-B'}],
  expectedHash:digest(original)});
 assert.equal(read(),'head\r\nchanged-A\r\nchanged-B\r\ntail\r\n');
 assert.equal(result.replacements,2);
 const revised=read();
 await assert.rejects(()=>edit({mode:'replace',oldText:'tail',newText:'end',expectedHash:digest(original)}),
  /FILE_VERSION_CONFLICT/);
 assert.equal(read(),revised);
 console.log('PASS replace_many is one-file atomic; dryRun and expectedHash protect edits');

 write('old\r\nname\r\n');
 const patch=createPatch('sample.txt','old\nname\n','new\nname\n');
 result=await edit({mode:'patch',patch});
 assert.equal(read(),'new\r\nname\r\n');
 assert.equal(result.changed,true);
 const beforeBadPatch=read();
 await assert.rejects(()=>edit({mode:'patch',patch:createPatch('sample.txt','not here\n','x\n')}),
  /PATCH_CONTEXT_MISMATCH/);
 assert.equal(read(),beforeBadPatch);
 console.log('PASS unified diff patch uses strict context and handles CRLF automatically');

 const valid=[
  {mode:'replace',oldText:'x',newText:''},
  {mode:'replace_many',replacements:[{oldText:'x',newText:'y'}]},
  {mode:'patch',patch:'@@ -1 +1 @@\n-a\n+b\n'},
 ];
 for(const input of valid)assert.ok(toolInputSchemas.fs_edit.safeParse({deviceId:'dev',path:file,...input}).success);
 const invalid=[
  {mode:'replace',oldText:'x'},
  {mode:'replace_many',replacements:[],oldText:'x'},
  {mode:'patch',patch:'abc',newText:'unexpected'},
  {mode:'replace',oldText:'x',newText:'y',unexpected:true}
 ];
 for(const input of invalid)assert.equal(toolInputSchemas.fs_edit.safeParse({deviceId:'dev',path:file,...input}).success,false);
 console.log('PASS structured schema validates each edit mode and rejects ambiguous arguments');
}finally{rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:50});}
