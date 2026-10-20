import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-tui-file-content-'));
process.env.DESKBEACON_DATA_DIR=root;
process.env.DESKBEACON_IPC_PATH=process.platform==='win32'
 ?'\\\\.\\pipe\\deskbeacon-file-preview-'+process.pid:join(root,'daemon.sock');
const prevCI=process.env.CI;
delete process.env.CI;
const [{ClientDaemon},{startIpc},{App},{closeLogs}]=await Promise.all([
 import('../dist/daemon.js'),import('../dist/ipc.js'),import('../dist/tui.js'),import('../dist/diagnostics.js')]);
const daemon=new ClientDaemon({url:'https://example.invalid',deviceId:'preview-fixture',
 clientId:'fixture',accessToken:'test-token',deviceName:'Preview device'});
const text='// LIVE TUI SELECTED FILE CONTENT\n'+'const a=12345;\n'.repeat(570);
const id='real-tui-preview',ref=daemon.journal.start(id,'fs_write',{
 path:'E:/fixture/stored-source.ts',mode:'rewrite',content:text});
daemon.journal.finish(id,{writtenBytes:Buffer.byteLength(text),sha256:'fixture'},'completed');
daemon.db.prepare('INSERT INTO activity (id,grant_id,tool,description,status,time,record_path,record_state) VALUES (?,?,?,?,?,?,?,?)')
 .run(id,'fixture','fs_write','fixture write','completed',Date.now(),ref,'complete');
daemon.activityRevision++;
const server=startIpc(daemon);
const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
const output=new PassThrough();output.columns=136;output.rows=47;output.isTTY=true;output.getColorDepth=()=>24;
let stream='';
output.on('data',buf=>stream+=buf.toString('utf8'));
let app;
try{
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
 app=render(React.createElement(App),{stdin:input,stdout:output,exitOnCtrlC:false});
 const deadline=Date.now()+7000;
 while(Date.now()<deadline&&!stream.includes('LIVE TUI SELECTED FILE CONTENT'))
  await new Promise(resolve=>setTimeout(resolve,45));
 assert.ok(stream.includes('FILE CONTENT'),'selected record should display file source section');
 assert.ok(stream.includes('LIVE TUI SELECTED FILE CONTENT'),
  'TUI should load the selected 8KiB JSONL input via IPC, not show a missing-history warning');
 assert.ok(!stream.slice(-5000).includes('历史记录未保存可预览的写入文本'));
 input.write('q');
 await Promise.race([app.waitUntilExit(),new Promise((_,reject)=>setTimeout(()=>reject(Error('TUI did not exit')),3000))]);
 console.log('PASS real Ink TUI + IPC + JSONL: selected fs_write >6K displays saved code content');
}finally{
 try{app?.unmount()}catch{}
 input.destroy();output.destroy();
 await Promise.race([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>setTimeout(resolve,1400))]);
 await daemon.shutdown();
 await closeLogs();
 if(prevCI===undefined)delete process.env.CI;else process.env.CI=prevCI;
 rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
