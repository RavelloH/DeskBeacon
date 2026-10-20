import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {render} from 'ink';
import {SetupDemoApp,setupDemoProgress} from '../dist/setup-demo-ui.js';
import {SETUP_PHASES} from '../dist/setup-flow.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-setup-demo-'));
const dataDir=join(root,'no-config-or-database');
process.env.DESKBEACON_DATA_DIR=dataDir;
const input=new PassThrough();
input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
const output=new PassThrough();
output.isTTY=true;output.columns=100;output.rows=28;output.getColorDepth=()=>24;
let text='';
output.on('data',part=>text+=part.toString());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(search,from=0)=>{
 for(let i=0;i<70;i++){if(text.slice(from).includes(search))return;await sleep(35);}
 assert.fail('Expected '+search+', got '+JSON.stringify(text.slice(-900)));
};
const app=render(React.createElement(SetupDemoApp),{stdin:input,stdout:output,exitOnCtrlC:false});
try{
 assert.deepEqual([0,1000,2500,4000,5500,9000,11000].map(t=>setupDemoProgress(t,'https://example.com').stage),
  [SETUP_PHASES[0],SETUP_PHASES[0],SETUP_PHASES[1],SETUP_PHASES[2],SETUP_PHASES[3],SETUP_PHASES[4],SETUP_PHASES[5]]);
 await waitFor('https://beacon.example.com');
 assert.match(text,/\[演示\]/);
 assert.match(text,/不会发起网络请求/);
 let from=text.length;
 input.write('https://qr.example');
 await waitFor('https://qr.example',from);
 assert.ok(!text.slice(from).includes('已退出授权演示'),'q/r must be legal URL input characters');
 from=text.length;
 input.write('\r');
 await waitFor('服务器：https://qr.example',from);
 from=text.length;
 input.write('4');
 await waitFor('以下为模拟授权网址',from);
 assert.ok(text.slice(from).includes('https://example.invalid/authorize?demo=setup'));
 from=text.length;
 input.write('e');
 await waitFor('模拟授权失败',from);
 from=text.length;
 input.write('r');
 await waitFor('请输入服务器地址',from);
 from=text.length;
 input.write('\r'); // Use the placeholder as a purely simulated server.
 await waitFor('服务器：https://beacon.example.com',from);
 from=text.length;
 input.write('s');
 await waitFor('模拟设备授权已完成，真实配置未改变。',from);
 const exit=app.waitUntilExit();
 await Promise.race([exit,sleep(2600).then(()=>{throw Error('Setup Demo did not auto-exit');})]);
 assert.equal(existsSync(dataDir),false,'Demo must not create a config or SQLite directory');
 console.log('PASS Setup Demo URL editing, placeholder, six-phase preview, fake OAuth link, failure, replay, finish, auto-exit, no real data');
}finally{app.unmount();input.destroy();output.destroy();rmSync(root,{recursive:true,force:true});}
