import React,{useEffect,useState} from 'react';
import {render,useApp,useInput} from 'ink';
import {UpdateScreen} from './update-tui.js';
import {UPDATE_PHASES,UPDATE_COMMANDS,type UpdateProgress,type UpdateResult,type UpdateKind} from './update-flow.js';

const DURATION=9000;
const ENDS=[1600,5200,7000,9000];
const CURRENT='0.2.0',LATEST='0.3.0';
export function updateDemoProgress(ms:number):UpdateProgress{
 const elapsed=Math.max(0,Math.min(DURATION,ms));
 const find=ENDS.findIndex(end=>elapsed<end);
 const index=find<0?ENDS.length-1:find;
 return{stage:UPDATE_PHASES[index]!,index,startedAt:Date.now()-elapsed,
  currentVersion:CURRENT,...(index>=2?{latestVersion:LATEST}:{})};
}
const mockResult=(kind:UpdateKind):UpdateResult=>({
 currentVersion:kind==='ahead'?'0.4.0':CURRENT,latestVersion:kind==='available'?LATEST:CURRENT,
 kind,commands:kind==='available'?UPDATE_COMMANDS:[]
});
export function UpdateDemoApp(){
 const {exit}=useApp();
 const [elapsed,setElapsed]=useState(0);
 const [paused,setPaused]=useState(false);
 const [result,setResult]=useState<UpdateResult|null>(null);
 const [error,setError]=useState('');
 const [leaving,setLeaving]=useState(false);
 useEffect(()=>{
  if(paused||result||error||leaving)return;
  const interval=setInterval(()=>setElapsed(ms=>Math.min(DURATION,ms+100)),100);
  return()=>clearInterval(interval);
 },[paused,result,error,leaving]);
 useEffect(()=>{
  if(elapsed<DURATION||result||error||leaving)return;
  setResult(mockResult('available'));
 },[elapsed,result,error,leaving]);
 useEffect(()=>{
  if(!result&&!error&&!leaving)return;
  const timer=setTimeout(()=>exit(),leaving?350:1100);
  return()=>clearTimeout(timer);
 },[result,error,leaving,exit]);
 useInput((value,key)=>{
  if(leaving)return;
  if(value==='q'||key.escape||(key.ctrl&&value==='c')){setLeaving(true);return;}
  if(value==='r'){setElapsed(0);setPaused(false);setResult(null);setError('');return;}
  if(result||error)return;
  if(value==='s'){setResult(mockResult('available'));return;}
  if(value==='u'){setResult(mockResult('current'));return;}
  if(value==='a'){setResult(mockResult('ahead'));return;}
  if(value==='e'){setError('模拟网络请求失败（未连接真实 npm）。');return;}
  if(value===' '){setPaused(v=>!v);return;}
  if(key.leftArrow||key.rightArrow){
   setElapsed(value=>Math.max(0,Math.min(DURATION,value+(key.rightArrow?1000:-1000))));return;
  }
  if(/^[1-4]$/.test(value)){setPaused(true);setElapsed(Number(value)===1?0:ENDS[Number(value)-2]!);}
 });
 return <UpdateScreen demo currentVersion={CURRENT} progress={updateDemoProgress(elapsed)}
  result={result} error={error} finalMessage={leaving?'— 已退出更新检查演示，没有修改任何软件。':''}/>;
}
export async function showUpdateDemo():Promise<void>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 const app=render(<UpdateDemoApp/>,{exitOnCtrlC:false});
 try{await app.waitUntilExit();}finally{app.unmount();}
}
