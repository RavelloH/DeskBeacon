import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'deskbeacon-setup-demo-cli-'));
const data=join(root,'never-write');
const wrapper=[
 'process.stdin.isTTY=true;process.stdout.isTTY=true;',
 'process.stdout.columns=105;process.stdout.rows=30;',
 'process.stdin.setRawMode=()=>process.stdin;',
 'process.argv=[process.execPath,'+JSON.stringify(entry)+',"demo","setup"];',
 'await import('+JSON.stringify(new URL('../dist/index.js',import.meta.url).href)+');',
].join('');
const child=spawn(process.execPath,['--input-type=module','-e',wrapper],{
 cwd:repo,env:{...process.env,DESKBEACON_DATA_DIR:data},windowsHide:true,stdio:['pipe','pipe','pipe'],
});
let stdout='',stderr='';
child.stdout.on('data',chunk=>stdout+=chunk.toString());
child.stderr.on('data',chunk=>stderr+=chunk.toString());
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(message){
 for(let i=0;i<130;i++){if(stdout.includes(message))return;await pause(30);}
 assert.fail('Expected '+message+', stderr='+stderr+' output='+stdout.slice(-1300));
}
try{
 await waitFor('[演示]');
 await waitFor('https://beacon.example.com');
 child.stdin.write('\r');
 await waitFor('服务器：https://beacon.example.com');
 child.stdin.write('s');
 await waitFor('模拟设备授权已完成，真实配置未改变。');
 const finished=new Promise(resolve=>child.once('exit',resolve));
 const status=await Promise.race([finished,pause(4000).then(()=>{throw Error('CLI Setup Demo did not auto-exit');})]);
 assert.equal(status,0,stderr);
 assert.equal(existsSync(data),false,'Demo must not create a device config or storage directory');
 console.log('PASS real deskbeacon demo setup command, placeholder, mock authorization, automatic exit and no filesystem writes');
}finally{child.kill();rmSync(root,{recursive:true,force:true});}
