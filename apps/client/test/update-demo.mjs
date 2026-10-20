import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import React from 'react';
import {render} from 'ink';
import {UpdateDemoApp,updateDemoProgress} from '../dist/update-demo-ui.js';
import {UPDATE_PHASES} from '../dist/update-flow.js';
const root=mkdtempSync(join(tmpdir(),'deskbeacon-update-demo-'));
const data=join(root,'should-not-exist');
process.env.DESKBEACON_DATA_DIR=data;
const stdout=new PassThrough();stdout.isTTY=true;stdout.columns=104;stdout.rows=25;stdout.getColorDepth=()=>24;
const stdin=new PassThrough();stdin.isTTY=true;stdin.setRawMode=()=>stdin;stdin.ref=()=>stdin;stdin.unref=()=>stdin;
let text='';stdout.on('data',chunk=>text+=chunk.toString());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(s,from=0)=>{
 for(let i=0;i<70;i++){if(text.slice(from).includes(s))return;await sleep(35);}
 assert.fail('Missing '+s+' in '+JSON.stringify(text.slice(-1500)));
};
const app=render(React.createElement(UpdateDemoApp),{stdin,stdout,exitOnCtrlC:false});
try{
 assert.deepEqual([0,2000,5600,7300].map(ms=>updateDemoProgress(ms).stage),UPDATE_PHASES);
 await waitFor('[演示]');
 assert.match(text,/不会访问网络或安装软件/);
 let from=text.length;
 stdin.write('3');
 await waitFor('npm latest：0.3.0',from);
 from=text.length;
 stdin.write('e');
 await waitFor('模拟网络请求失败',from);
 from=text.length;
 stdin.write('r');
 await waitFor('检查流程',from);
 from=text.length;
 stdin.write('s');
 await waitFor('发现新版本：0.2.0 → 0.3.0',from);
 assert.match(text,/npm install -g deskbeacon@latest/);
 await Promise.race([app.waitUntilExit(),sleep(2700).then(()=>{throw Error('Demo did not auto exit');})]);
 assert.equal(existsSync(data),false,'Update demo must not write runtime data');
 console.log('PASS Update Demo stages, simulated network failure, restart, upgrade advice, auto exit, and no disk writes');
}finally{app.unmount();stdout.destroy();stdin.destroy();rmSync(root,{recursive:true,force:true});}
