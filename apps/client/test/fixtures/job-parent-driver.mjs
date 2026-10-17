import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
 import { join } from 'node:path';
import { TaskSupervisor } from '../../dist/process.js';
const folder=process.argv[2];
if(!folder)throw Error('usage: parent-driver dir');
mkdirSync(folder,{recursive:true});
const db=new DatabaseSync(join(folder,'driver.db'));
const supervisor=new TaskSupervisor(db,join(folder,'output'));
const file=join(folder,'daemon-grandchild.txt');
const script=[
'const {spawn}=require("node:child_process");',
'const fs=require("node:fs");',
'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});',
'fs.writeFileSync('+JSON.stringify(file)+',String(child.pid));',
'setInterval(()=>{},1000);'
].join('');
await supervisor.startBackground('orphan-parent','Crash recovery test',{mode:'program',program:process.execPath,args:['-e',script]});
process.stdout.write('READY\n');
setInterval(()=>{},1000);
