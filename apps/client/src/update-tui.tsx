import React,{useEffect,useRef,useState} from 'react';
import {Box,Text,render,useInput,useStdout} from 'ink';
import {checkForUpdates,updateSummary,UPDATE_PHASES,type UpdateProgress,type UpdateResult} from './update-flow.js';

const accent='#FDE68A';
const frames=['⣾','⣷','⣯','⣟','⡿','⢿','⣻','⣽'] as const;
const duration=(ms:number)=>ms<1000?Math.round(ms)+'ms':(ms/1000).toFixed(1)+'s';
export function UpdateScreen({currentVersion,progress=null,result=null,error='',demo=false,finalMessage=''}:{
 currentVersion:string;progress?:UpdateProgress|null;result?:UpdateResult|null;
 error?:string;demo?:boolean;finalMessage?:string;
}){
 const {stdout}=useStdout();
 const [frame,setFrame]=useState(0);
 const history=useRef({index:-1,start:Date.now(),durations:new Map<number,number>()});
 const compact=!!result||!!error||!!finalMessage;
 const active=progress?.index??0;
 if(!compact&&active!==history.current.index){
  if(active<history.current.index)history.current.durations.clear();
  else if(history.current.index>=0)history.current.durations.set(history.current.index,Date.now()-history.current.start);
  history.current.index=active;history.current.start=Date.now();
 }
 useEffect(()=>{
  if(compact)return;
  const timer=setInterval(()=>setFrame(value=>(value+1)%frames.length),125);
  timer.unref?.();return()=>clearInterval(timer);
 },[compact]);
 const rule=<Box width="100%" height={1}>
  <Text color={accent}>{'━'.repeat(Math.max(1,stdout.columns??80))}</Text>
 </Box>;
 if(compact)return <Box flexDirection="column">
  {rule}
  <Box paddingX={2}><Text color={finalMessage?'gray':error?'red':result?.kind==='available'?'cyan':'green'}>{
   finalMessage|| (error?'✗ 更新检查失败：'+error:
    (result?.kind==='available'?'↑ ':'✓ ')+(result?updateSummary(result):'更新检查结束'))
  }</Text></Box>
  {result?.kind==='available'?<Box flexDirection="column" paddingX={2}>
   <Text color="gray">不会自动安装；可以选择以下方式：</Text>
   <Text color="cyan">{'  '+result.commands[0]}</Text>
   <Text color="gray">{'  或 '+result.commands[1]}</Text>
  </Box>:null}
 </Box>;
 return <Box flexDirection="column" height={Math.max(14,stdout.rows??24)}>
  {rule}
  <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
   <Box marginBottom={1}><Text color={accent} bold>(( · )) DeskBeacon  ·  检查更新</Text>{demo?<Text color="gray"> [演示]</Text>:null}</Box>
   <Text color="gray">{demo?'模拟查询 npm 发布信息，不会访问网络或安装软件。':'检查 npm 上的 DeskBeacon 发布版本，不会自动下载或安装。'}</Text>
   <Box marginTop={1}><Text bold>当前版本：{currentVersion}</Text></Box>
   {progress?.latestVersion?<Text color="gray">npm latest：{progress.latestVersion}</Text>:null}
   <Box marginTop={1} flexDirection="column">
    <Text bold>检查流程</Text>
    {UPDATE_PHASES.map((stage,index)=>{
     const done=Boolean(progress)&&index<active;
     const running=Boolean(progress)&&index===active;
     const marker=done?'✓':running?frames[frame]:'-';
     const elapsed=history.current.durations.get(index);
     return <Box key={stage}>
      <Text>{'  '}</Text>
      <Text color={done?'green':running?'cyan':'gray'}>{marker+' '}</Text>
      <Text color="gray">{stage}{done&&elapsed!==undefined?' ('+duration(elapsed)+')':''}</Text>
     </Box>;
    })}
   </Box>
   <Box marginTop={1}>
    <Text color="gray">{demo?'1–4 阶段 · ←/→ 进度 · 空格 暂停 · s 有新版 · u 已最新 · a 本地领先 · e 失败 · r 重来 · q/Esc 退出':'正在查询 npm 注册表，按 Esc 取消检查…'}</Text>
   </Box>
  </Box>
 </Box>;
}

export async function updateTui(currentVersion:string):Promise<UpdateResult>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 let setProgress!:(p:UpdateProgress)=>void;
 let setResult!:(r:UpdateResult)=>void;
 let setError!:(error:string)=>void;
 const controller=new AbortController();
 function App(){
  const [progress,progressUpdate]=useState<UpdateProgress|null>(null);
  const [result,finish]=useState<UpdateResult|null>(null);
  const [error,fail]=useState('');
  setProgress=progressUpdate;setResult=finish;setError=fail;
  useInput((value,key)=>{if(key.escape||(key.ctrl&&value==='c'))controller.abort();});
  return <UpdateScreen currentVersion={currentVersion} progress={progress} result={result} error={error}/>;
 }
 const app=render(<App/>,{exitOnCtrlC:false});
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));
  const result=await checkForUpdates(currentVersion,{onProgress:p=>setProgress(p),signal:controller.signal});
  setResult(result);
  await new Promise(resolve=>setTimeout(resolve,850));
  return result;
 }catch(e){
  const error=e instanceof Error?e:new Error(String(e));
  setError(error.message);
  await new Promise(resolve=>setTimeout(resolve,1000));
  (error as Error&{updateScreenReported?:boolean}).updateScreenReported=true;
  throw error;
 }finally{app.unmount();}
}
