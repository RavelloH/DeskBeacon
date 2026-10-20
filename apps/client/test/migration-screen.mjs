import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {MigrationScreen} from '../dist/migration-tui.js';
const out=new PassThrough();out.isTTY=true;out.columns=92;out.rows=30;out.getColorDepth=()=>24;
const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
let text='';out.on('data',chunk=>text+=chunk.toString('utf8'));
const first={stage:'Migrating operation records',from:'0.1.0',to:'0.2.0',completed:60,total:100,
 percent:60,elapsedMs:1000,etaMs:700,detail:'operation records'};
const app=render(React.createElement(MigrationScreen,{progress:first,done:false,error:''}),{stdin:input,stdout:out,exitOnCtrlC:false});
try{
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.ok(text.includes('DeskBeacon'), 'migration header must be visible');
 assert.ok(text.includes('数据迁移'),'迁移标题必须使用中文');
 assert.ok(text.includes('━'.repeat(out.columns)),'顶部横线必须铺满终端宽度');
 if(process.env.FORCE_COLOR==='3')assert.ok(text.includes('\x1b[38;2;215;166;74m'),'顶部横线应使用指定金色');
 assert.ok(text.includes('0.1.0')&&text.includes('0.2.0'));
 assert.ok(text.includes('60%'));
 assert.ok(text.includes('预计剩余'));
 app.rerender(React.createElement(MigrationScreen,{progress:{...first,completed:100,percent:100,etaMs:null},done:true,error:''}));
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.ok(text.includes('迁移已完成'));
 assert.ok(!text.includes('ACTIVITY'),'migration page must not render the normal activity list');
 console.log('PASS dedicated full-screen Ink migration screen and time/percentage/finish indicators');
}finally{app.unmount();input.destroy();out.destroy();}
