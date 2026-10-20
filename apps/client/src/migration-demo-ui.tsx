import React,{useEffect,useState} from 'react';
import {render,useApp,useInput} from 'ink';
import {MigrationScreen} from './migration-tui.js';
import {MIGRATION_DEMO_DURATION_MS,MIGRATION_DEMO_STEPS,migrationDemoFinished,migrationDemoProgress} from './migration-demo.js';

/** Interactive preview of the exact production migration screen, without accessing local storage. */
export function MigrationDemoApp(){
 const [elapsed,setElapsed]=useState(0);
 const [paused,setPaused]=useState(false);
 const [error,setError]=useState('');
 const [speed,setSpeed]=useState(1);
 const {exit}=useApp();
 const done=migrationDemoFinished(elapsed);
 useEffect(()=>{
  if(paused||Boolean(error)||done)return;
  const timer=setInterval(()=>setElapsed(previous=>Math.min(MIGRATION_DEMO_DURATION_MS,previous+100*speed)),100);
  return ()=>clearInterval(timer);
 },[paused,error,done,speed]);
 useInput((input,key)=>{
  if(input==='q'||key.escape){exit();return;}
  if(input==='r'){
   setError('');setPaused(false);setElapsed(0);return;
  }
  if(input==='e'){setError('模拟错误：无法读取旧版记录，原始数据已保留。');setPaused(true);return;}
  if(input===' '){if(!error)setPaused(previous=>!previous);return;}
  if(input==='s'){setError('');setElapsed(MIGRATION_DEMO_DURATION_MS);setPaused(true);return;}
  if(input==='+'||input==='='){setSpeed(previous=>Math.min(8,previous*2));return;}
  if(input==='-'){setSpeed(previous=>Math.max(1,previous/2));return;}
  if(key.leftArrow||key.rightArrow){
   setElapsed(previous=>Math.max(0,Math.min(MIGRATION_DEMO_DURATION_MS,previous+(key.rightArrow?2000:-2000))));
   return;
  }
  if(/^[1-5]$/.test(input)){
   setElapsed(MIGRATION_DEMO_STEPS[Number(input)-1]!.start);
   setError('');setPaused(true);
  }
 });
 return <MigrationScreen progress={migrationDemoProgress(elapsed)} done={done} error={error}
  demo paused={paused} speed={speed}/>;
}

export async function showMigrationDemo():Promise<void>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 const instance=render(<MigrationDemoApp/>,{exitOnCtrlC:false});
 try{await instance.waitUntilExit();}finally{instance.unmount();}
}
