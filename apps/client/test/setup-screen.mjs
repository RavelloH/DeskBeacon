import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {SetupScreen} from '../dist/setup-tui.js';
import {SETUP_PHASES} from '../dist/setup-flow.js';

const stdout=new PassThrough();stdout.isTTY=true;stdout.columns=105;stdout.rows=30;stdout.getColorDepth=()=>24;
const stdin=new PassThrough();stdin.isTTY=true;stdin.setRawMode=()=>stdin;stdin.ref=()=>stdin;stdin.unref=()=>stdin;
let chunks=[];stdout.on('data',chunk=>chunks.push(chunk.toString('utf8')));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const step={stage:SETUP_PHASES[3],index:3,startedAt:Date.now()-1000,server:'https://example.com',
 authorizeUrl:'https://example.com/authorize?client_id=fake&state=state'};
const app=render(React.createElement(SetupScreen,{progress:step}),{stdin,stdout,exitOnCtrlC:false});
try{
 await wait(160);
 const text=chunks.join('');
 assert.ok(text.includes('(( · )) DeskBeacon'));
 assert.match(text,/设备授权/);
 assert.match(text,/授权流程/);
 assert.match(text,/浏览器完成授权/);
 assert.ok(text.includes('━'.repeat(stdout.columns)),'full width rule');
 if(process.env.FORCE_COLOR==='3'){
  const rgb='\x1b[38;2;253;230;138m';
  assert.ok(text.split(rgb).length>=3,'title and rule share RGB');
 }
 for(const phase of SETUP_PHASES)assert.ok(text.includes(phase),'missing stage '+phase);
 assert.ok(!text.includes('├─')&&!text.includes('└─'));
 const plain=text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
 assert.match(plain,/    ✓ 注册 OAuth 客户端/);
 assert.match(plain,/    - 交换访问令牌/);

 let from=chunks.length;
 app.rerender(React.createElement(SetupScreen,{progress:null,editing:true,url:'https://localhost'}));
 await wait(100);
 const entry=chunks.slice(from).join('');
 assert.match(entry,/请输入服务器地址/);
 from=chunks.length;
 app.rerender(React.createElement(SetupScreen,{progress:null,editing:true,url:''}));
 await wait(105);
 const emptyInput=chunks.slice(from).join('');
 assert.match(emptyInput,/https:\/\/beacon\.example\.com/,'Empty setup input needs a visible URL placeholder');
 assert.ok(emptyInput.includes('▌'),'Placeholder should display the input caret');
 const cleanTerminal=(content)=>content.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');
 const visibleEmpty=cleanTerminal(emptyInput).split(/\r?\n/);
 assert.ok(visibleEmpty.some(line=>/>\s*▌https:\/\/beacon\.example\.com/.test(line)),
  'Prompt, caret and placeholder must render on one horizontal line: '+JSON.stringify(visibleEmpty.slice(-9)));
 from=chunks.length;
 app.rerender(React.createElement(SetupScreen,{progress:null,editing:true,url:'https://real.example'}));
 await wait(100);
 const filledInput=chunks.slice(from).join('');
 assert.match(filledInput,/https:\/\/real\.example/);
 assert.ok(!filledInput.includes('https://beacon.example.com'),'Placeholder must disappear as soon as the user types');
 const visibleFilled=cleanTerminal(filledInput).split(/\r?\n/);
 assert.ok(visibleFilled.some(line=>/>\s*https:\/\/real\.example▌/.test(line)),
  'Prompt, entered URL and caret must remain on one horizontal line: '+JSON.stringify(visibleFilled.slice(-9)));
 assert.match(entry,/https:\/\/localhost/);
 from=chunks.length;
 app.rerender(React.createElement(SetupScreen,{progress:step,done:true,deviceId:'device-test'}));
 await wait(110);
 const done=chunks.slice(from).join('');
 assert.ok(done.includes('━'.repeat(stdout.columns)));
 assert.match(done,/✓ 设备授权已完成（device-test）/);
 assert.ok(!done.includes('授权流程'),'completion must be compact');
 from=chunks.length;
 app.rerender(React.createElement(SetupScreen,{progress:step,error:'模拟连接失败'}));
 await wait(110);
 const error=chunks.slice(from).join('');
 assert.match(error,/✗ 设备授权失败：模拟连接失败/);
 assert.ok(!error.includes('授权流程'));
 console.log('PASS Chinese setup Ink full-width title, six-phase tree, URL entry, compact success and failure');
}finally{app.unmount();stdin.destroy();stdout.destroy();}
