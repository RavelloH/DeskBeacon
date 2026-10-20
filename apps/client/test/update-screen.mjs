import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {UpdateScreen} from '../dist/update-tui.js';
import {UPDATE_PHASES,UPDATE_COMMANDS} from '../dist/update-flow.js';

const out=new PassThrough();out.isTTY=true;out.columns=96;out.rows=28;out.getColorDepth=()=>24;
const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
const chunks=[];out.on('data',data=>chunks.push(data.toString('utf8')));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const p={stage:UPDATE_PHASES[2],index:2,startedAt:Date.now()-600,currentVersion:'0.2.0',latestVersion:'0.3.0'};
const show=(options={})=>React.createElement(UpdateScreen,{currentVersion:'0.2.0',progress:p,...options});
const app=render(show(),{stdin:input,stdout:out,exitOnCtrlC:false});
try{
 await pause(170);
 const text=chunks.join('');
 assert.match(text,/DeskBeacon.*检查更新/);
 assert.match(text,/检查流程/);
 assert.match(text,/当前版本：0\.2\.0/);
 assert.match(text,/npm latest：0\.3\.0/);
 for(const phase of UPDATE_PHASES)assert.ok(text.includes(phase),'missing '+phase);
 assert.ok(text.includes('━'.repeat(out.columns)),'full width gold divider');
 assert.ok(!/[├└]─/.test(text),'tree should use indentation and icons');
 if(process.env.FORCE_COLOR==='3')assert.ok(text.split('\x1b[38;2;253;230;138m').length>=3,
  'title and divider must share explicit RGB');
 let from=chunks.length;
 const result={currentVersion:'0.2.0',latestVersion:'0.3.0',kind:'available',commands:UPDATE_COMMANDS};
 app.rerender(show({result}));
 await pause(110);
 const completed=chunks.slice(from).join('');
 assert.match(completed,/发现新版本：0\.2\.0 → 0\.3\.0/);
 assert.match(completed,/npm install -g deskbeacon@latest/);
 assert.match(completed,/npx deskbeacon@latest/);
 assert.doesNotMatch(completed,/检查流程/,'finish should collapse progress tree');
 from=chunks.length;
 app.rerender(show({result:{currentVersion:'0.2.0',latestVersion:'0.2.0',kind:'current',commands:[]}}));
 await pause(100);
 const current=chunks.slice(from).join('');
 assert.match(current,/已是最新版本：0\.2\.0/);
 assert.ok(!current.includes('npm install -g'),'up to date does not need install commands');
 from=chunks.length;
 app.rerender(show({result:null,error:'模拟网络连接失败'}));
 await pause(100);
 const failure=chunks.slice(from).join('');
 assert.match(failure,/✗ 更新检查失败：模拟网络连接失败/);
 assert.doesNotMatch(failure,/检查流程/);
 console.log('PASS update Ink Chinese phases, golden RGB divider, compact version/install result, current, and error');
}finally{app.unmount();input.destroy();out.destroy();}
