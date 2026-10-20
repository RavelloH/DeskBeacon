import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cwd=fileURLToPath(new URL('../../../',import.meta.url));
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'deskbeacon-demo-route-'));
const data=join(root,'should-not-be-created');
const wrapper=[
 'process.stdin.isTTY=true;',
 'process.stdout.isTTY=true;',
 'process.stdout.columns=100;process.stdout.rows=27;',
 'process.stdin.setRawMode=()=>process.stdin;',
 'process.argv=[process.execPath,'+JSON.stringify(entry)+',"demo","migration"];',
 'await import('+JSON.stringify('file:///'+entry.replaceAll('\\','/'))+');'
].join('');
const child=spawn(process.execPath,['--input-type=module','-e',wrapper],{
 cwd,env:{...process.env,DESKBEACON_DATA_DIR:data},windowsHide:true,stdio:['pipe','pipe','pipe']
});
let out='',err='';
child.stdout.on('data',buf=>out+=buf.toString());
child.stderr.on('data',buf=>err+=buf.toString());
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(text)=>{
 for(let i=0;i<100;i++){if(out.includes(text))return;await pause(30);}
 assert.fail('Expected CLI TUI: '+text+', stderr='+err+', output='+out.slice(-700));
};
try{
 await waitFor('[演示]');
 child.stdin.write('q');
 const code=await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(4000).then(()=>{throw Error('CLI demo did not exit');})]);
 assert.equal(code,0,err);
 assert.equal(existsSync(data),false,'demo route must not touch the chosen data folder');
 console.log('PASS real deskbeacon demo migration CLI dispatch and exit without local DB access');
}finally{child.kill();rmSync(root,{recursive:true,force:true});}
