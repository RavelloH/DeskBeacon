import React,{useEffect,useRef,useState} from 'react';
import {Box,Text,render,useStdout} from 'ink';
import type {MigrationProgress} from './storage-migrations.js';
import {runStorageMigrations,type MigrationResult} from './storage-migrations.js';
import {MIGRATION_PHASES,migrationPhaseIndex} from './migration-phases.js';

function clock(ms:number|null):string{
 if(ms===null)return '正在估算剩余时间…';
 const sec=Math.ceil(ms/1000);
 return sec<60?'预计剩余 '+sec+' 秒':'预计剩余 '+Math.floor(sec/60)+' 分 '+(sec%60)+' 秒';
}
function duration(ms:number):string{
 return ms<1000?Math.round(ms)+'ms':(ms/1000).toFixed(1)+'s';
}

const frames=['⣾','⣷','⣯','⣟','⡿','⢿','⣻','⣽'] as const;
// Explicit RGB prevents Windows Terminal from mapping bold ANSI yellow to a brighter palette entry.
const accent='#FDE68A';
declare const __DESKBEACON_RELEASE__:boolean;
const DEMO_ENABLED=typeof __DESKBEACON_RELEASE__==='undefined'||!__DESKBEACON_RELEASE__;

/** Shared by foreground migration and the development-only simulation.
 * A finished or failed migration intentionally reduces to two terminal lines,
 * so the full-screen progress layout does not remain in the scrollback. */
export function MigrationScreen({progress,done,error,demo=false,paused=false,speed=1,finalMessage=''}:{
 progress:MigrationProgress|null;done:boolean;error:string;
 demo?:boolean;paused?:boolean;speed?:number;finalMessage?:string;
}){
 const {stdout}=useStdout();
 const preview=DEMO_ENABLED&&demo;
 const compact=done||Boolean(error)||Boolean(finalMessage);
 const columns=Math.max(1,stdout.columns??80);
 const width=Math.max(12,Math.min(68,columns-9));
 const percent=progress?.percent??0,filled=Math.round(width*percent/100);
 const [frame,setFrame]=useState(0);
 const currentIndex=Math.max(0,migrationPhaseIndex(progress?.stage));
 const history=useRef({index:-1,startedAt:Date.now(),durations:new Map<number,number>()});
 // Track only transitions actually seen by this UI (no database or extra polling).
 if(!compact&&currentIndex!==history.current.index){
  const previous=history.current.index;
  if(currentIndex<previous)history.current.durations.clear(); // demo rewind/replay
  else if(previous>=0&&previous<MIGRATION_PHASES.length)
   history.current.durations.set(previous,Date.now()-history.current.startedAt);
  history.current.index=currentIndex;
  history.current.startedAt=Date.now();
 }
 useEffect(()=>{
  if(compact||paused)return;
  const timer=setInterval(()=>setFrame(value=>(value+1)%frames.length),110);
  timer.unref?.();
  return ()=>clearInterval(timer);
 },[compact,paused]);
 const rule=<Box height={1} width="100%">
  <Text color={accent}>{'━'.repeat(columns)}</Text>
 </Box>;

 if(compact){
  const result=finalMessage|| (error
   ?'✗ 数据迁移失败：'+error
   :preview?'✓ 模拟迁移已完成，真实数据未改变。'
    :'✓ 数据迁移已完成'+(progress?'（'+progress.from+' → '+progress.to+'）':'')+'。');
  return <Box flexDirection="column">
   {rule}
   <Box paddingX={2}><Text color={finalMessage?'gray':error?'red':'green'}>{result}</Text></Box>
  </Box>;
 }

 return <Box flexDirection="column" height={Math.max(13,stdout.rows??24)}>
  {rule}
  <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
   <Box marginBottom={1}>
    <Text bold color={accent}>(( · )) DeskBeacon  ·  数据迁移</Text>
    {preview?<Text color="gray">  [演示]</Text>:null}
   </Box>
   <Text color="gray">{preview?'迁移界面预览：不会修改任何真实数据。':'正在更新本地记录，迁移完成后才会启动 DeskBeacon。'}</Text>
   <Text color="gray">{preview?'所有阶段均为模拟，不会连接服务器或操作数据库。':'迁移期间设备将暂时处于离线状态。'}</Text>
   <Box marginTop={1}><Text bold>{progress?progress.from+'  →  '+progress.to:'正在检查本地数据…'}</Text></Box>
   <Box marginTop={1}><Text color="cyan">{'█'.repeat(filled)}</Text><Text color="gray">{'░'.repeat(width-filled)}</Text></Box>
   <Text>{percent.toString().padStart(3)}%   {progress?'已处理 '+progress.completed+' / '+progress.total+' 项':'正在准备…'}   {clock(progress?.etaMs??null)}</Text>
   <Box marginTop={1} flexDirection="column">
    <Box><Text color="cyan">{frames[frame]}</Text><Text color="gray"> 迁移流程</Text></Box>
    {MIGRATION_PHASES.map((stage,index)=>{
     const isActive=index===currentIndex;
     const isDone=index<currentIndex;
     const marker=isDone?'✓':isActive?(paused?'⏸':frames[frame]):'-';
     const color=isDone?'green':isActive?'cyan':'gray';
     const elapsed=history.current.durations.get(index);
     const detail=isActive&&progress&&index===1
      ?'（'+progress.completed+' / '+progress.total+'）'
      :isDone&&elapsed!==undefined?'（'+duration(elapsed)+'）':'';
     return <Box key={stage}>
      <Text>{'  '}</Text>
      <Text color={color}>{marker+' '}</Text>
      <Text color="gray">{stage}</Text>
      {detail?<Text color="gray"> {detail}</Text>:null}
     </Box>;
    })}
   </Box>
   {preview?<Box marginTop={1} flexDirection="column">
    <Text color="gray">空格 {paused?'继续':'暂停'}  ·  ←/→ 调整进度  ·  1–5 切换阶段  ·  +/- 倍速（{speed}x）</Text>
    <Text color="gray">r 重新开始  ·  e 模拟错误  ·  s 立即完成  ·  q / Esc 退出</Text>
   </Box>:null}
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
  // Let Ink commit the compact two-line result before unmounting the live view.
  await new Promise(resolve=>setTimeout(resolve,450));
  return result;
 }catch(e){
  fail(e instanceof Error?e.message:String(e));
  await new Promise(resolve=>setTimeout(resolve,1000));
  // The compact error message is already on screen; CLI should not duplicate it.
  const error=e instanceof Error?e:new Error(String(e));
  (error as Error&{migrationScreenReported?:boolean}).migrationScreenReported=true;
  throw error;
 }finally{instance.unmount();}
}
