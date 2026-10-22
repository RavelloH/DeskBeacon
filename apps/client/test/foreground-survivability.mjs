import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-foreground-survivability-'));
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const pipe=process.platform==='win32'?'\\\\.\\pipe\\deskbeacon-foreground-survive-'+process.pid:join(root,'daemon.sock');
const env={...process.env,DESKBEACON_DATA_DIR:root,DESKBEACON_IPC_PATH:pipe};
process.env.DESKBEACON_DATA_DIR=root;process.env.DESKBEACON_IPC_PATH=pipe;
writeFileSync(join(root,'config.json'),JSON.stringify({
 url:'http://127.0.0.1:9',deviceName:'resilience-test',deviceId:'resilience-test',
 clientId:'resilience-test',accessToken:'isolation-only'
}));
const {requestIpc}=await import('../dist/ipc.js');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wrapper=[
 'process.stdin.isTTY=true;process.stdout.isTTY=true;',
 'process.stdout.columns=95;process.stdout.rows=27;',
 'process.stdin.setRawMode=()=>process.stdin;',
 'process.argv=[process.execPath,'+JSON.stringify(entry)+'];',
 'await import('+JSON.stringify(new URL('../dist/index.js',import.meta.url).href)+');',
].join('');
function launch(){
 const child=spawn(process.execPath,['--input-type=module','-e',wrapper],{
  cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']
 });
 let output='',stderr='';
 child.stdout.on('data',part=>output+=part.toString());
 child.stderr.on('data',part=>stderr+=part.toString());
 return{child,output:()=>output,stderr:()=>stderr};
}
async function ready(){
 for(let i=0;i<100;i++){
  try{return await requestIpc({action:'status'},300);}catch{}
  await wait(100);
 }
 throw Error('supervisor did not start Runtime');
}
async function stopped(){
 for(let i=0;i<125;i++){
  try{await requestIpc({action:'status'},300);}catch{return;}
  await wait(130);
 }
 throw Error('Runtime was not stopped');
}
async function waitExit(child,ms=15000){
 if(child.exitCode!==null||child.signalCode!==null)return;
 await Promise.race([
  new Promise(resolve=>child.once('exit',resolve)),
  wait(ms).then(()=>{throw Error('TUI did not exit within '+ms+'ms');})
 ]);
}
function serviceStop(){
 const r=spawnSync(process.execPath,[entry,'service','stop'],{env,cwd:root,encoding:'utf8',timeout:35000,windowsHide:true});
 assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
}
try{
 // Simulate a fatal OS-level process termination, for which JS finally/exit
 // handlers cannot run. The separately supervised Runtime must remain alive.
 const unexpected=launch();
 const active=await ready();
 assert.equal(active.runtimeMode,'background','supervision must own the Runtime');
 assert.ok(existsSync(join(root,'supervisor.lock')),'supervisor lock must exist');
 await wait(320);
 unexpected.child.kill('SIGKILL');
 await waitExit(unexpected.child,5000);
 const survived=await requestIpc({action:'status'},1200);
 assert.equal(survived.deviceId,'resilience-test');
 assert.ok(existsSync(join(root,'supervisor.lock')));
 console.log('PASS forced TUI process crash keeps device Runtime and Supervisor online');
 // An existing service must remain online after a user closes an attached TUI.
 const attached=launch();
 await wait(900);
 attached.child.stdin.write('q');
 await waitExit(attached.child,6500);
 let afterAttach=null;
 try{afterAttach=await requestIpc({action:'status'},1500);}catch(error){
  console.log('TRACE after attach IPC failure',String(error));
  for(const domain of ['tui','runtime','service']){const p=join(root,'logs',domain+'.jsonl');if(existsSync(p))console.log('TRACE',domain,readFileSync(p,'utf8').slice(-2500));}
 }
 assert.equal(afterAttach?.deviceId,'resilience-test');
 console.log('PASS attached TUI q does not stop a pre-existing background service');
 serviceStop();
 await stopped();
 // Fresh TUI-created service still stops on deliberate q.
 const owned=launch();
 await ready();
 await wait(700);
 owned.child.stdin.write('q');
 await waitExit(owned.child,33000);
 await stopped();
 assert.equal(existsSync(join(root,'supervisor.lock')),false);
 console.log('PASS fresh frontend q stops its own supervised Runtime cleanly');
}finally{
 try{serviceStop();}catch{}
 await wait(330);
 rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:180});
}
