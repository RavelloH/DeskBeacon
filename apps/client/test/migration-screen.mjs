import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {MigrationScreen} from '../dist/migration-tui.js';
import {MIGRATION_PHASES} from '../dist/migration-phases.js';

const out=new PassThrough();
out.isTTY=true;out.columns=92;out.rows=30;out.getColorDepth=()=>24;
const input=new PassThrough();
input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
const chunks=[];
out.on('data',chunk=>chunks.push(chunk.toString('utf8')));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const first={
 stage:'校验 JSONL 日志',from:'0.1.0',to:'0.2.0',completed:60,total:100,
 percent:60,elapsedMs:1000,etaMs:700
};
const view=(progress,done=false,error='')=>React.createElement(MigrationScreen,{progress,done,error});
const app=render(view(first),{stdin:input,stdout:out,exitOnCtrlC:false});
try{
 await sleep(160);
 const initial=chunks.join('');
 assert.match(initial,/DeskBeacon.*数据迁移/);
 assert.ok(initial.includes('━'.repeat(out.columns)),'黄色横线须覆盖整个终端宽度');
 assert.ok(!initial.includes('\x1b[38;2;215;166;74m'),'不能继续使用旧金色');
 if(process.env.FORCE_COLOR==='3'){
  const rgb='\x1b[38;2;253;230;138m';
  assert.ok(initial.split(rgb).length>=3,'标题和横线都应使用相同的显式 RGB，而不是粗体映射的 ANSI 调色板');
 }
 assert.match(initial,/0\.1\.0/);assert.match(initial,/0\.2\.0/);
 assert.match(initial,/60%/);assert.match(initial,/预计剩余/);
 assert.match(initial,/迁移流程/);
 for(const phase of MIGRATION_PHASES)assert.ok(initial.includes(phase),'missing tree node: '+phase);
 assert.doesNotMatch(initial,/[├└]─/,'树节点应像 InsightFlare 一样只显示缩进和状态符号');
 const plainInitial=initial.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
 assert.match(plainInitial,/    ✓ 迁移操作记录/,'完成项应缩进并显示勾号');
 assert.match(plainInitial,/    - 检查旧版输出文件/,'待执行项应缩进并显示破折号');
 assert.match(initial,/✓/,'finished stages must show checkmarks');
 assert.match(initial,/⣾|⣷|⣯|⣟|⡿|⢿|⣻|⣽/,'active stage must show animated spinner');

 let offset=chunks.length;
 app.rerender(view({...first,completed:100,percent:100,stage:'已完成 0.2.0 升级',etaMs:null},true));
 await sleep(130);
 const final=chunks.slice(offset).join('');
 assert.ok(final.includes('━'.repeat(out.columns)),'the compact result retains the full width rule');
 assert.match(final,/✓ 数据迁移已完成（0\.1\.0 → 0\.2\.0）/);
 for(const phase of MIGRATION_PHASES)assert.ok(!final.includes(phase),'compact result must remove tree step '+phase);
 assert.ok(!final.includes('迁移流程')&&!final.includes('已处理')&&!final.includes('预计剩余'),'compact result removes progress UI');
 const plain=final.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').replace(/\x1b\][^\x07]*\x07/g,'');
 assert.ok(plain.split(/\r?\n/).filter(Boolean).length<=3,'compact layout should occupy two lines');

 offset=chunks.length;
 app.rerender(view(first,false,'模拟迁移出错'));
 await sleep(130);
 const failed=chunks.slice(offset).join('');
 assert.match(failed,/✗ 数据迁移失败：模拟迁移出错/);
 assert.ok(!failed.includes('迁移流程'),'failure also collapses the progress tree');
 console.log('PASS migration tree rendering, yellow full-width rule, spinner, and two-line success/error teardown');
}finally{app.unmount();input.destroy();out.destroy();}
