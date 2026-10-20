import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'deskbeacon-update-demo-cli-'));
const data=join(root,'must-remain-empty');
const wrapper=[
 'process.stdin.isTTY=true;process.stdout.isTTY=true;',
 'process.stdout.columns=110;process.stdout.rows=29;',
 'process.stdin.setRawMode=()=>process.stdin;',
 'process.argv=[process.execPath,'+JSON.stringify(entry)+',"demo","update"];',
 'await import('+JSON.stringify(new URL('../dist/index.js',import.meta.url).href)+');',
].join('');
const child=spawn(process.execPath,['--input-type=module','-e',wrapper],{
 env:{...process.env,DESKBEACON_DATA_DIR:data},windowsHide:true,stdio:['pipe','pipe','pipe']
});
let stdout='',stderr='';
child.stdout.on('data',buf=>stdout+=buf.toString());
child.stderr.on('data',buf=>stderr+=buf.toString());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(value){
 for(let i=0;i<100;i++){if(stdout.includes(value))return;await sleep(30);}
 assert.fail('Expected '+value+' from CLI, output '+stdout.slice(-1500)+' stderr '+stderr);
}
try{
 await waitFor('[演示]');
 await waitFor('检查流程');
 child.stdin.write('s');
 await waitFor('发现新版本：0.2.0 → 0.3.0');
 const exit=new Promise(resolve=>child.once('exit',resolve));
 const code=await Promise.race([exit,sleep(3000).then(()=>{throw Error('Update demo did not auto-exit');})]);
 assert.equal(code,0,stderr);
 assert.equal(existsSync(data),false,'Demo must not write local device data');
 console.log('PASS deskbeacon demo update route, complete preview, auto exit, no filesystem writes');
}finally{child.kill();rmSync(root,{recursive:true,force:true});}
