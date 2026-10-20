import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {render} from 'ink';
import {MIGRATION_DEMO_DURATION_MS,MIGRATION_DEMO_STEPS,migrationDemoProgress,migrationDemoFinished}
 from '../dist/migration-demo.js';
import {MigrationDemoApp} from '../dist/migration-tui.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-demo-migration-'));
const dataDir=join(root,'no-real-storage');
process.env.DESKBEACON_DATA_DIR=dataDir;
const snapshots=[0,500,1500,5000,10000,16000,22000,23500,24000,30000].map(migrationDemoProgress);
for(let i=1;i<snapshots.length;i++){
 assert.ok(snapshots[i].percent>=snapshots[i-1].percent,'percent must never decrease');
 assert.ok(snapshots[i].completed>=snapshots[i-1].completed,'record count must never decrease');
}
assert.equal(snapshots[0].percent,0);
assert.equal(snapshots.at(-1).percent,100);
assert.equal(migrationDemoFinished(MIGRATION_DEMO_DURATION_MS-1),false);
assert.equal(migrationDemoFinished(MIGRATION_DEMO_DURATION_MS),true);
assert.equal(new Set(MIGRATION_DEMO_STEPS.map(stage=>stage.stage)).size,6);

const input=new PassThrough();
input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
const output=new PassThrough();
output.isTTY=true;output.columns=105;output.rows=28;output.getColorDepth=()=>24;
let all='';
output.on('data',chunk=>all+=chunk.toString('utf8'));
const app=render(React.createElement(MigrationDemoApp),{stdin:input,stdout:output,exitOnCtrlC:false});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(text,from=0)=>{for(let i=0;i<30;i++){if(all.slice(from).includes(text))return;await pause(35);}assert.fail('Expected screen content: '+text+'  latest='+JSON.stringify(all.slice(-2200)))};
try{
 await waitFor('[演示]');
 assert.ok(all.includes('所有阶段均为模拟，不会连接服务器或操作数据库。'));
 assert.ok(all.includes('空格 暂停'));
 let from=all.length;
 input.write(' ');
 await waitFor('空格 继续',from);
 from=all.length;
 input.write('4');
 await waitFor('检查旧版输出文件',from);
 from=all.length;
 input.write('e');
 await waitFor('模拟错误',from);
 from=all.length;
 input.write('r');
 await waitFor('空格 暂停',from);
 from=all.length;
 input.write('s');
 await waitFor('模拟迁移已完成，真实数据未改变。',from);
 const exit=app.waitUntilExit();
 input.write('q');
 await Promise.race([exit,pause(2000).then(()=>{throw Error('Demo did not exit on q');})]);
 assert.equal(existsSync(dataDir),false,'demo must not create SQLite, JSONL or config folders');
 assert.ok(!all.includes('ACTIVITY'),'the migration demo must not render the main TUI');
 console.log('PASS migration demo animation, stage navigation, pause, error, replay, finish, q-exit and zero filesystem writes');
}finally{app.unmount();input.destroy();output.destroy();rmSync(root,{recursive:true,force:true});}
