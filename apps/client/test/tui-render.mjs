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
output.on('data',data=>screen+=data.toString('utf8'));
try{
 await new Promise((resolve,reject)=>{listener.once('listening',resolve);listener.once('error',reject);});
 const app=render(React.createElement(App),{stdin:input,stdout:output,exitOnCtrlC:false});
 await new Promise(resolve=>setTimeout(resolve,800));
 assert.ok(screen.includes('DeskBeacon'),'main screen is missing brand');
 assert.ok(screen.includes('ACTIVITY'),'screen is missing activity region');
 assert.ok(screen.includes('CPU'),'screen is missing resource status bar');
 assert.ok(screen.includes('((x))')||screen.includes('((!))')||screen.includes('((·))'),'connection logo is missing');
 assert.ok(screen.includes('搜索'),'search key hints are missing');
 console.log('PASS full-screen TUI renders status bars, activity and localized controls');
 input.write('q');
 await Promise.race([app.waitUntilExit(),new Promise((_,reject)=>setTimeout(()=>reject(Error('TUI did not exit')),3000))]);
 console.log('PASS keyboard q closes the frontend');
}finally{
 await new Promise(resolve=>listener.close(resolve));
 daemon.stop();
}
