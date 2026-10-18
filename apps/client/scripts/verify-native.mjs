import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const client=dirname(dirname(fileURLToPath(import.meta.url)));
const arch=process.argv[2]??'win-x64';
if(!['win-x64','win-arm64'].includes(arch))throw Error('Unknown NativeAOT target '+arch);
const exe=process.argv[3]??join(client,'dist','native',arch,'deskbeacon-job.exe');
const dir=dirname(exe);
const size=statSync(exe).size;
assert.ok(size>800_000,'NativeAOT single-file executable is missing; framework-dependent stub must never ship as npm runtime ('+size+' bytes)');
const files=readdirSync(dir);
assert.ok(!files.some(name=>name.endsWith('.runtimeconfig.json')||name.endsWith('.dll')),
  'NativeAOT dist must contain no .NET runtimeconfig or managed DLL dependencies');
if(process.platform==='win32'&&process.arch==='x64'&&arch==='win-x64'){
 const command=Buffer.from(JSON.stringify({File:process.execPath,Args:['-e','console.log("DESKBEACON_JOB_VERIFIED")'],
    Cwd:process.cwd(),ParentPid:process.pid}),'utf8').toString('base64');
 const run=spawnSync(exe,[command],{cwd:process.cwd(),encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(run.status,0,run.stderr);
 assert.ok(run.stdout.includes('DESKBEACON_JOB_VERIFIED'),run.stdout);
}
console.log('NativeAOT ready for packaging',arch,(size/1024/1024).toFixed(2)+' MiB');
