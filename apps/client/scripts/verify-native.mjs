import assert from 'node:assert/strict';
import {readFileSync,statSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const platform=process.argv[2]??'win32-x64';
if(!['win32-x64','win32-arm64'].includes(platform))throw Error('Unknown C helper architecture '+platform);
const exe=process.argv[3]??join(root,'packages',platform,'deskbeacon-job.exe');
assert.ok(existsSync(exe),'Native executable missing: '+exe);
const size=statSync(exe).size;
assert.ok(size>16000&&size<2*1024*1024,'Expected compact standalone C executable, found '+size+' bytes');
const data=readFileSync(exe);
assert.equal(data.subarray(0,2).toString('ascii'),'MZ','Not a Windows PE executable');
const peOffset=data.readUInt32LE(0x3c);
assert.equal(data.toString('ascii',peOffset,peOffset+4),'PE\0\0','Invalid Windows PE image');
const machine=data.readUInt16LE(peOffset+4);
assert.equal(machine,platform==='win32-x64'?0x8664:0xaa64,'Wrong target CPU architecture');
if(process.platform==='win32'&&process.arch==='x64'&&platform==='win32-x64'){
 const command=Buffer.from(JSON.stringify({
  File:process.execPath,Args:['-e','console.log("DESKBEACON_C_JOB_OK")'],Cwd:process.cwd(),ParentPid:process.pid
 }),'utf8').toString('base64');
 const test=spawnSync(exe,[command],{encoding:'utf8',cwd:process.cwd(),timeout:15000,windowsHide:true});
 assert.equal(test.status,0,'Windows helper execution failed: '+test.stderr);
 assert.match(test.stdout,/DESKBEACON_C_JOB_OK/);
 // Standard input is forwarded by the native launcher, not by Node directly.
 // The target must observe EOF even when there are no input bytes.
 for(const [name,input,expected] of [
  ['empty EOF','','NATIVE_STDIN_EOF='],
  ['explicit stdin','native-test-input','NATIVE_STDIN_EOF=native-test-input']
 ]){
  const eofPayload=Buffer.from(JSON.stringify({
   File:process.execPath,
   Args:['-e',"let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>console.log('NATIVE_STDIN_EOF='+text));process.stdin.resume();"],
   Cwd:process.cwd(),ParentPid:process.pid
  }),'utf8').toString('base64');
  const eof=spawnSync(exe,[eofPayload],{
   input,encoding:'utf8',cwd:process.cwd(),timeout:4500,windowsHide:true
  });
  assert.equal(eof.status,0,'Windows helper did not forward '+name+': '+(eof.error?.message??eof.stderr));
  assert.ok(eof.stdout.includes(expected),'Missing native stdin/EOF result for '+name+': '+eof.stdout);
 }
}
console.log('C Win32 Job Object helper verified',platform,size,'bytes');
