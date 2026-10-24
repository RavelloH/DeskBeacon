import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {availableShells,browserOpenCommand,cpuCount,androidHomeDiskSnapshot} from '../dist/platform-compat.js';
import {ripgrepExecutable} from '../dist/ripgrep.js';

test('Android shell discovery works without the which executable',{skip:process.platform==='win32'?'Windows filesystem does not emulate POSIX X_OK':false},()=>{
 const dir=mkdtempSync(join(tmpdir(),'deskbeacon-termux-path-'));
 try{
  for(const shell of ['bash','sh','zsh']){
   const p=join(dir,shell);
   writeFileSync(p,'#!/bin/sh\nexit 0\n');
   chmodSync(p,0o755);
  }
  assert.deepEqual(availableShells('android',dir),['bash','zsh','sh']);
  assert.deepEqual(availableShells('linux',dir),['bash','zsh','sh']);
  assert.deepEqual(availableShells('android',join(dir,'missing')),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Termux browser launcher uses Android intent helper',()=>{
 const url='https://beacon.example.com/authorize';
 assert.deepEqual(browserOpenCommand(url,'android'),{program:'termux-open-url',args:[url]});
 assert.deepEqual(browserOpenCommand(url,'linux'),{program:'xdg-open',args:[url]});
 assert.deepEqual(browserOpenCommand(url,'darwin'),{program:'open',args:[url]});
 assert.deepEqual(browserOpenCommand(url,'win32'),{program:'rundll32.exe',args:['url.dll,FileProtocolHandler',url]});
});

test('CPU count never returns zero on Android-like builds',()=>{
 assert.ok(cpuCount()>=1);
});

test('statfs fallback returns usable filesystem data and handles restricted paths',()=>{
 const disks=androidHomeDiskSnapshot(tmpdir());
 assert.equal(disks.length,1);
 assert.equal(disks[0].mount,tmpdir());
 assert.ok(disks[0].totalBytes>0);
 assert.ok(disks[0].usedBytes>=0);
 assert.ok(disks[0].usedPercent>=0&&disks[0].usedPercent<=100);
 assert.deepEqual(androidHomeDiskSnapshot(join(tmpdir(),'not-existing-dir-deskbeacon-123456789')),[]);
});

test('Android falls back to system ripgrep without loading unavailable platform packages',async()=>{
 assert.equal(await ripgrepExecutable('android'),'rg');
 if(process.platform==='android')assert.equal(await ripgrepExecutable(),'rg');
});
