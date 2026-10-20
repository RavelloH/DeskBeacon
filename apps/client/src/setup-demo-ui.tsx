import React,{useEffect,useState} from 'react';
import {render,useApp,useInput} from 'ink';
import {SetupScreen,SETUP_URL_PLACEHOLDER} from './setup-tui.js';
import {SETUP_PHASES,validateSetupUrl,type SetupProgress} from './setup-flow.js';

const DURATION_MS=12_000;
const STAGE_ENDS=[1800,3300,4800,8500,10000,12000];
export function setupDemoProgress(elapsed:number,server:string):SetupProgress{
 const bounded=Math.min(DURATION_MS,Math.max(0,elapsed));
 const index=Math.min(SETUP_PHASES.length-1,STAGE_ENDS.findIndex(end=>bounded<end)<0
  ?SETUP_PHASES.length-1:STAGE_ENDS.findIndex(end=>bounded<end));
 return {
  stage:SETUP_PHASES[index]!,index,startedAt:Date.now()-bounded,server,
  ...(index===3?{authorizeUrl:'https://example.invalid/authorize?demo=setup&scope=deskbeacon%3Adevice'}:{}),
 };
}
export function SetupDemoApp(){
 const {exit}=useApp();
 const [input,setInput]=useState('');
 const [inputError,setInputError]=useState('');
 const [editing,setEditing]=useState(true);
 const [server,setServer]=useState(SETUP_URL_PLACEHOLDER);
 const [elapsed,setElapsed]=useState(0);
 const [paused,setPaused]=useState(false);
 const [error,setError]=useState('');
 const [leaving,setLeaving]=useState(false);
 const [speed,setSpeed]=useState(1);
 const done=!editing&&elapsed>=DURATION_MS;
 useEffect(()=>{
  if(editing||paused||Boolean(error)||done||leaving)return;
  const timer=setInterval(()=>setElapsed(value=>Math.min(DURATION_MS,value+100*speed)),100);
  return ()=>clearInterval(timer);
 },[editing,paused,error,done,leaving,speed]);
 useEffect(()=>{
  if(!done||leaving)return;
  const timer=setTimeout(()=>exit(),1100);
  return ()=>clearTimeout(timer);
 },[done,leaving,exit]);
 useEffect(()=>{
  if(!leaving)return;
  const timer=setTimeout(()=>exit(),350);
  return ()=>clearTimeout(timer);
 },[leaving,exit]);
 useInput((value,key)=>{
  if(leaving)return;
  if(key.escape||(key.ctrl&&value==='c')||(!editing&&value==='q')){setLeaving(true);return;}
  if(!editing&&value==='r'){
   setInput('');setInputError('');setServer(SETUP_URL_PLACEHOLDER);
   setElapsed(0);setPaused(false);setError('');setEditing(true);return;
  }
  if(editing){
   if(key.return){
    try{
     const target=validateSetupUrl(input.trim()||SETUP_URL_PLACEHOLDER);
     setServer(target);setElapsed(0);setPaused(false);setError('');setEditing(false);
    }catch(e){setInputError(e instanceof Error?e.message:String(e));}
    return;
   }
   if(key.backspace||key.delete){setInput(text=>text.slice(0,-1));setInputError('');return;}
   if(value&&!key.ctrl&&!key.meta){
    setInput(text=>text+value.replace(/[\r\n]/g,''));setInputError('');
   }
   return;
  }
  if(value==='e'){
   setError('模拟错误：OAuth 授权被拒绝，真实配置未改变。');
   setPaused(true);return;
  }
  if(value==='s'){setError('');setElapsed(DURATION_MS);setPaused(true);return;}
  if(value===' '){if(!error&&!done)setPaused(value=>!value);return;}
  if(value==='+'||value==='='){setSpeed(v=>Math.min(8,v*2));return;}
  if(value==='-'){setSpeed(v=>Math.max(0.5,v/2));return;}
  if(key.leftArrow||key.rightArrow){
   setError('');setElapsed(v=>Math.max(0,Math.min(DURATION_MS,v+(key.rightArrow?1200:-1200))));return;
  }
  if(/^[1-6]$/.test(value)){
   setError('');setPaused(true);
   setElapsed(Number(value)===1?0:STAGE_ENDS[Number(value)-2]!);
  }
 });
 return <SetupScreen demo progress={editing?null:setupDemoProgress(elapsed,server)}
  editing={editing} url={editing?input:server} inputError={inputError}
  error={error} done={done}
  finalMessage={leaving?'— 已退出设备授权演示，真实配置未改变。':''}/>;
}
export async function showSetupDemo():Promise<void>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 const instance=render(<SetupDemoApp/>,{exitOnCtrlC:false});
 try{await instance.waitUntilExit();}finally{instance.unmount();}
}
