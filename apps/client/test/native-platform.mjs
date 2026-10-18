import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolveWindowsJobBinary} from '../dist/process.js';
const old=process.env.DESKBEACON_JOB_BINARY;
const errorMessage=call=>{try{call();throw Error('EXPECTED_ERROR_NOT_THROWN');}catch(e){return String(e.message);}};
try{
 delete process.env.DESKBEACON_JOB_BINARY;
 assert.match(errorMessage(()=>resolveWindowsJobBinary('win32','ia32')),
  /WINDOWS_JOB_HELPER_MISSING/);
 assert.match(errorMessage(()=>resolveWindowsJobBinary('linux','x64')),
  /WINDOWS_JOB_HELPER_MISSING/);
 if(process.platform==='win32'){
  const current=resolveWindowsJobBinary();
  assert.ok(existsSync(current));
  assert.ok(current.includes('@deskbeacon')||current.includes('packages'),
   'normal runtime must resolve native platform package, not a bundled legacy helper');
 }
 process.env.DESKBEACON_JOB_BINARY='Z:/deskbeacon/definitely-missing.exe';
 assert.match(errorMessage(()=>resolveWindowsJobBinary('win32','x64')),
  /WINDOWS_JOB_HELPER_MISSING/);
 console.log('PASS platform optional dependency resolver and missing-native error boundaries');
}finally{
 if(old===undefined)delete process.env.DESKBEACON_JOB_BINARY;
 else process.env.DESKBEACON_JOB_BINARY=old;
}
