import React,{useState} from 'react';
import {Box,Text,render,useStdout} from 'ink';
import type {MigrationProgress} from './storage-migrations.js';
import {runStorageMigrations,type MigrationResult} from './storage-migrations.js';

function clock(ms:number|null):string{
 if(ms===null)return '正在估算剩余时间…';
 const sec=Math.ceil(ms/1000);
 return sec<60?'预计剩余 '+sec+' 秒':'预计剩余 '+Math.floor(sec/60)+' 分 '+(sec%60)+' 秒';
}

declare const __DESKBEACON_RELEASE__:boolean;
const DEMO_ENABLED=typeof __DESKBEACON_RELEASE__==='undefined'||!__DESKBEACON_RELEASE__;
/** One screen for production and for simulated migration previews. */
export function MigrationScreen({progress,done,error,demo=false,paused=false,speed=1}:{
 progress:MigrationProgress|null;done:boolean;error:string;
 demo?:boolean;paused?:boolean;speed?:number;
}){
 const {stdout}=useStdout();
 const preview=DEMO_ENABLED&&demo;
 const width=Math.max(12,Math.min(68,(stdout.columns??80)-9));
 const percent=progress?.percent??0,filled=Math.round(width*percent/100);
 return <Box flexDirection="column" height={Math.max(10,stdout.rows??24)}>
   <Box width="100%" height={1}><Text color="#D7A64A">{'━'.repeat(Math.max(1,stdout.columns??80))}</Text></Box>
   <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
   <Box marginBottom={1}><Text bold color="yellow">(( · )) DeskBeacon  ·  数据迁移</Text>{preview?<Text color="gray">  [演示]</Text>:null}</Box>
   <Text color="gray">{preview?'迁移界面预览：不会修改任何真实数据。':'正在更新本地记录，迁移完成后才会启动 DeskBeacon。'}</Text>
   <Text color="gray">{preview?'所有阶段均为模拟，不会连接服务器或操作数据库。':'迁移期间设备将暂时处于离线状态。'}</Text>
   <Box marginTop={1}><Text bold>{progress?progress.from+'  →  '+progress.to:'正在检查本地数据…'}</Text></Box>
   <Box marginTop={1}><Text color="cyan">{'█'.repeat(filled)}</Text><Text color="gray">{'░'.repeat(width-filled)}</Text></Box>
   <Text>{percent.toString().padStart(3)}%   {progress?'已处理 '+progress.completed+' / '+progress.total+' 项':'正在准备…'}   {clock(progress?.etaMs??null)}</Text>
   <Box marginTop={1}><Text color="gray">{progress?.stage??'正在检查存储结构与已有记录'}</Text></Box>
   {error?<Box marginTop={1}><Text color="red">{error}</Text></Box>:null}
   {preview?<Box marginTop={1} flexDirection="column">
     <Text color="gray">空格 {paused?'继续':'暂停'}  ·  ←/→ 调整进度  ·  1–5 切换阶段  ·  +/- 倍速（{speed}x）</Text>
     <Text color="gray">r 重新开始  ·  e 模拟错误  ·  s 立即完成  ·  q / Esc 退出</Text>
   </Box>:null}
   {done?<Box marginTop={1}><Text color="green">{preview?'模拟迁移已完成，真实数据未改变。':'迁移已完成，正在启动 DeskBeacon…'}</Text></Box>:null}
   </Box>
 </Box>;
}

export async function migrationTui():Promise<MigrationResult>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 let update!:(p:MigrationProgress|null)=>void,completed!:(value:boolean)=>void,fail!:(value:string)=>void;
 function App(){
  const [progress,setProgress]=useState<MigrationProgress|null>(null);
  const [done,setDone]=useState(false),[error,setError]=useState('');
  update=setProgress;completed=setDone;fail=setError;
  return <MigrationScreen progress={progress} done={done} error={error}/>;
 }
 const instance=render(<App/>,{exitOnCtrlC:false});
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));
  const result=await runStorageMigrations({onProgress:p=>update(p)});
  completed(true);
  await new Promise(resolve=>setTimeout(resolve,350));
  return result;
 }catch(e){
  fail(e instanceof Error?e.message:String(e));
  await new Promise(resolve=>setTimeout(resolve,750));
  throw e;
 }finally{instance.unmount();}
}
