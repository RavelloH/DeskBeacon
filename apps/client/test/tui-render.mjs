import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {ClientDaemon} from '../dist/daemon.js';
import {startIpc} from '../dist/ipc.js';
import {App} from '../dist/tui.js';
const config={
 url:'http://127.0.0.1:65530',deviceId:'tui-test',clientId:'tui-test',
 accessToken:'isolated-test-token',deviceName:'TUI fixture'
};
const daemon=new ClientDaemon(config);
const listener=startIpc(daemon);
const output=new PassThrough();
output.columns=100;output.rows=28;output.isTTY=true;
output.getColorDepth=()=>24;
const input=new PassThrough();
input.isTTY=true;input.setRawMode=()=>input;
let screen='';
let app;
output.on('data',data=>screen+=data.toString('utf8'));
try{
 await new Promise((resolve,reject)=>{listener.once('listening',resolve);listener.once('error',reject);});
 app=render(React.createElement(App),{stdin:input,stdout:output,exitOnCtrlC:false});
 await new Promise(resolve=>setTimeout(resolve,800));
 if(!process.env.CI){
   assert.ok(screen.includes('DeskBeacon'),'main screen is missing brand');
   assert.ok(screen.includes('ACTIVITY'),'screen is missing activity region');
   assert.ok(screen.includes('CPU'),'screen is missing resource status bar');
   assert.ok(screen.includes('((x))')||screen.includes('((!))')||screen.includes('((·))'),'connection logo is missing');
   assert.ok(screen.includes('搜索'),'search key hints are missing');
   console.log('PASS full-screen TUI renders status bars, activity and localized controls');
 }else{
   // Ink suppresses all ANSI rendering when CI=true. Exercise deterministic
   // user-visible presentation independently of the skipped terminal paint.
   const {actionLabel,argumentLines,resultLines}=await import('../dist/presenter.js');
   const entry={id:'1',grant_id:'agent',tool:'fs_read',description:'Read source',status:'completed',
     time:Date.now(),request_json:JSON.stringify({path:'C:/example.txt'}),result:JSON.stringify({path:'C:/example.txt'})};
   assert.equal(actionLabel(entry),'读取了文件');
   assert.ok(argumentLines(entry).some(line=>line.includes('example.txt')));
   assert.ok(resultLines(entry).length>0);
   console.log('PASS localized TUI presenter under CI (Ink suppresses ANSI paint)');
 }
 input.write('q');
 await Promise.race([app.waitUntilExit(),new Promise((_,reject)=>setTimeout(()=>reject(Error('TUI did not exit')),3000))]);
 console.log('PASS keyboard q closes the frontend');
}finally{
 // A React/Ink assertion can throw before q is sent. Unmount must always
 // dispose useEffect subscriptions or Node keeps an IPC socket open forever.
 try{app?.unmount();}catch{}
 input.destroy();
 output.destroy();
 await Promise.race([
   new Promise(resolve=>listener.close(resolve)),
   new Promise(resolve=>setTimeout(resolve,1200))
 ]);
 daemon.stop();
}
