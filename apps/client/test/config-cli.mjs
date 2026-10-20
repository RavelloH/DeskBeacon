import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-config-cli-'));
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'?
 '\\\\.\\pipe\\deskbeacon-config-test-'+process.pid:join(root,'device.sock');
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const env={...process.env,DESKBEACON_DATA_DIR:root,DESKBEACON_IPC_PATH:process.env.DESKBEACON_IPC_PATH};
const {ClientDaemon,saveConfig,loadConfig}=await import('../dist/daemon.js');
const {startIpc}=await import('../dist/ipc.js');
const base={deviceName:'ASUS 原设备',url:'https://original.example',deviceId:'test-id',clientId:'test-id',
 accessToken:'DO_NOT_LEAK_ACCESS',refreshToken:'DO_NOT_LEAK_REFRESH'};
saveConfig(base);
const offline=(...args)=>spawnSync(process.execPath,[entry,'config',...args],{env,encoding:'utf8',timeout:9000});
const online=(...args)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[entry,'config',...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let out='',err='';
 child.stdout.on('data',d=>out+=d.toString('utf8'));
 child.stderr.on('data',d=>err+=d.toString('utf8'));
 child.on('error',reject);
 child.on('close',code=>resolve({status:code,stdout:out,stderr:err}));
});
let daemon,server;
try{
 const list=offline();
 assert.equal(list.status,0);
 assert.match(list.stdout,/deskbeacon config <name\|url> \[value\]/);
 const name=offline('name');
 assert.equal(name.status,0,name.stderr);assert.match(name.stdout,/name = ASUS 原设备/);
 const url=offline('url');
 assert.equal(url.status,0,url.stderr);assert.match(url.stdout,/url = https:\/\/original.example/);
 const offlineName=offline('name','修改但不应保存');
 assert.equal(offlineName.status,1);assert.match(offlineName.stderr,/设备名称需要同步到服务器/);
 assert.equal(loadConfig().deviceName,'ASUS 原设备');
 const wrong=offline('url','http://unsecured.example');
 assert.equal(wrong.status,1);assert.equal(loadConfig().pendingUrl,undefined);
 const pending=offline('url','https://new.example');
 assert.equal(pending.status,0,pending.stderr);assert.match(pending.stdout,/新 URL 已暂存/);
 let cfg=loadConfig();
 assert.equal(cfg.url,'https://original.example');assert.equal(cfg.pendingUrl,'https://new.example');
 assert.equal(cfg.accessToken,'DO_NOT_LEAK_ACCESS');assert.equal(cfg.refreshToken,'DO_NOT_LEAK_REFRESH');
 const pendingRead=offline('url');assert.match(pendingRead.stdout,/待重新授权后切换/);
 assert.ok(!pendingRead.stdout.includes('DO_NOT_LEAK'),'must never display credentials');
 const clear=offline('url','https://original.example');
 assert.equal(clear.status,0,clear.stderr);assert.equal(loadConfig().pendingUrl,undefined);
 const unknown=offline('invalid','value');
 assert.equal(unknown.status,1);assert.match(unknown.stderr,/name\|url/);
 const path=offline('url','https://new.example/path');
 assert.equal(path.status,1);assert.equal(loadConfig().pendingUrl,undefined);
 const multi=offline('name','two','words','not','allowed','offline');
 assert.equal(multi.status,1);assert.equal(loadConfig().deviceName,'ASUS 原设备');

 // The running CLI must use the same local IPC as the TUI, not mutate the file itself.
 daemon=new ClientDaemon({...loadConfig()});
 const calls=[];
 daemon.rename=async(value)=>{
  calls.push(value);
  const updated=loadConfig();saveConfig({...updated,deviceName:value});
  return value;
 };
 server=startIpc(daemon);
 if(!server.listening)await once(server,'listening');
 const rename=await online('name','新设备','带空格');
 assert.equal(rename.status,0,rename.stderr);
 assert.match(rename.stdout,/设备名称已同步：新设备 带空格/);
 assert.deepEqual(calls,['新设备 带空格']);
 assert.equal(loadConfig().deviceName,'新设备 带空格');
 const runtimeGet=await online('name');assert.match(runtimeGet.stdout,/name = 新设备 带空格/);
 const runtimeUrl=await online('url','https://another.example');
 assert.equal(runtimeUrl.status,0,runtimeUrl.stderr);
 assert.match(runtimeUrl.stdout,/重新授权后切换/);
 assert.equal(loadConfig().pendingUrl,'https://another.example');
 assert.equal(loadConfig().url,'https://original.example');
 console.log('PASS CLI config syntax, offline read and URL staging, IPC-backed rename, OAuth isolation, and errors');
}finally{
 if(server)await new Promise(resolve=>server.close(resolve));
 if(daemon)await daemon.shutdown();
 rmSync(root,{recursive:true,force:true});
}
