import React,{useEffect,useRef,useState} from 'react';
import {Box,Text,render,useInput,useStdout} from 'ink';
import {runSetupFlow,validateSetupUrl,SETUP_PHASES,type SetupProgress} from './setup-flow.js';
import {DEVICE_SETUP_PHASES,runDeviceSetupFlow} from './device-pairing.js';

const accent='#FDE68A';
export const SETUP_URL_PLACEHOLDER='https://beacon.example.com';
const frames=['⣾','⣷','⣯','⣟','⡿','⢿','⣻','⣽'];
const duration=(ms:number)=>ms<1000?Math.round(ms)+'ms':(ms/1000).toFixed(1)+'s';
export function SetupScreen({progress,editing=false,url='',done=false,error='',deviceId='',inputError='',demo=false,finalMessage=''}:{
 progress:SetupProgress|null;editing?:boolean;url?:string;done?:boolean;error?:string;
 deviceId?:string;inputError?:string;demo?:boolean;finalMessage?:string;
}){
 const {stdout}=useStdout();
 const [frame,setFrame]=useState(0),[now,setNow]=useState(Date.now());
 const history=useRef({last:-1,since:Date.now(),durations:new Map<number,number>()});
 const compact=done||Boolean(error)||Boolean(finalMessage),active=progress?.index??0;
 const phases=progress?.mode==='device'?DEVICE_SETUP_PHASES:SETUP_PHASES;
 if(!compact&&!editing&&active!==history.current.last){
  if(history.current.last>=0&&active>history.current.last)
   history.current.durations.set(history.current.last,Date.now()-history.current.since);
  history.current.last=active;history.current.since=Date.now();
 }
 useEffect(()=>{
  if(compact)return;
  const timer=setInterval(()=>{setFrame(v=>(v+1)%frames.length);setNow(Date.now());},150);
  timer.unref?.();return()=>clearInterval(timer);
 },[compact]);
 const rule=<Box width="100%" height={1}>
  <Text color={accent}>{'━'.repeat(Math.max(1,stdout.columns??80))}</Text>
 </Box>;
 if(compact)return <Box flexDirection="column">{rule}
  <Box paddingX={2}><Text color={finalMessage?'gray':error?'red':'green'}>{
   finalMessage|| (error
    ?(demo?'✗ 模拟授权失败：':'✗ 设备授权失败：')+error
    :demo?'✓ 模拟设备授权已完成，真实配置未改变。'
    :'✓ 设备授权已完成'+(deviceId?'（'+deviceId+'）':'')+'。')
  }</Text></Box>
 </Box>;
 return <Box flexDirection="column" height={Math.max(16,stdout.rows??24)}>
  {rule}
  <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
   <Box marginBottom={1}><Text color={accent} bold>(( · )) DeskBeacon  ·  设备授权</Text>{demo?<Text color="gray"> [演示]</Text>:null}</Box>
   <Text color="gray">{demo?'授权流程演示：不会发起网络请求，也不会写入真实设备配置。':'通过 OAuth 安全连接当前设备与 DeskBeacon 服务器。'}</Text>
   <Box marginTop={1} flexDirection="column">
    <Text bold>授权流程</Text>
    {phases.map((step,i)=>{
     const finished=Boolean(progress)&&!editing&&i<active;
     const running=Boolean(progress)&&!editing&&i===active;
     const icon=finished?'✓':running?frames[frame]:'-';
     const elapsed=history.current.durations.get(i);
     return <Box key={step}>
      <Text>{'  '}</Text>
      <Text color={finished?'green':running?'cyan':'gray'}>{icon+' '}</Text>
      <Text color="gray">{step}{finished&&elapsed!==undefined?' ('+duration(elapsed)+')':''}</Text>
     </Box>;
    })}
   </Box>
   <Box marginTop={1} flexDirection="column">
    {editing?<Box flexDirection="column">
     <Text color="cyan">请输入服务器地址，按 Enter 继续：</Text>
     <Text wrap="truncate-end">{'  > '}
      {url?<><Text color="white">{url}</Text><Text color="cyan">▌</Text></>:
       <><Text color="cyan">▌</Text><Text color="gray">{SETUP_URL_PLACEHOLDER}</Text></>}
     </Text>

     <Text color="gray">{demo?'按 Enter 使用示例地址开始模拟；Esc / q 退出。':'要求 HTTPS；本机 localhost 可使用 HTTP。Esc 取消。'}</Text>
     {inputError?<Text color="red">{inputError}</Text>:null}
    </Box>:
     <Text color="gray">服务器：{progress?.server??url}</Text>}
    {progress?.userCode&&progress.verificationUri?<Box marginTop={1} flexDirection="column">
     <Text color="cyan">在手机或其他电脑上访问以下网址：</Text>
     <Text wrap="wrap">{progress.verificationUri}</Text>
     <Text color="yellow" bold>配对验证码：{progress.userCode}</Text>
     <Text color="gray">请在浏览器输入验证码和管理密钥 · 最长等待 5 分钟</Text>
     <Text color="gray">按 Esc 取消设备授权 · 已等待 {duration(now-history.current.since)}</Text>
    </Box>:null}
    {progress?.authorizeUrl?<Box marginTop={1} flexDirection="column">
     <Text color="cyan">{demo?'以下为模拟授权网址，不需要打开：':'请在浏览器完成授权；如未自动打开，请复制下列网址：'}</Text>
     <Text wrap="wrap">{progress.authorizeUrl}</Text>
     <Text color="gray">{demo?'正在模拟浏览器回调':'等待 OAuth 回调（最长 3 分钟）'} · 已等待 {duration(now-history.current.since)}</Text>
     <Text color="gray">{demo?'s 完成 · e 失败 · 空格 暂停 · ←/→ 进度 · r 重来 · q/Esc 退出':'按 Esc 取消授权'}</Text>
    </Box>:null}
   </Box>
  </Box>
 </Box>;
}
export async function setupTui(initialUrl?:string,method:'browser'|'device'='browser'):Promise<{deviceId:string;server:string}>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 let accept!:(url:string)=>void,rejectInput!:(error:Error)=>void;
 const selected=new Promise<string>((resolve,reject)=>{accept=resolve;rejectInput=reject;});
 let updateProgress!:(p:SetupProgress)=>void;
 let finish!:(deviceId:string)=>void;
 let fail!:(message:string)=>void;
 const abort=new AbortController();
 function App(){
  const [input,setInput]=useState('');
  const [editing,setEditing]=useState(!initialUrl);
  const [inputError,setInputError]=useState('');
  const [progress,setProgress]=useState<SetupProgress|null>(null);
  const [done,setDone]=useState(false);
  const [error,setError]=useState('');
  const [deviceId,setDeviceId]=useState('');
  const submitted=useRef(false);
  updateProgress=setProgress;
  finish=id=>{setDeviceId(id);setDone(true);};
  fail=setError;
  useInput((value,key)=>{
   if(key.escape||key.ctrl&&value==='c'){
    if(editing)rejectInput(Error('用户取消了设备授权'));
    else abort.abort();
    return;
   }
   if(!editing)return;
   if(key.return){
    if(submitted.current)return;
    const raw=input.trim();
    try{validateSetupUrl(raw);}
    catch(e){setInputError(e instanceof Error?e.message:String(e));return;}
    submitted.current=true;setEditing(false);accept(raw);return;
   }
   if(key.backspace||key.delete){setInput(v=>v.slice(0,-1));setInputError('');return;}
   if(value&&!key.ctrl&&!key.meta){setInput(v=>v+value.replace(/[\r\n]/g,''));setInputError('');}
  });
  return <SetupScreen editing={editing} url={editing?input:(progress?.server??initialUrl??'')}
   progress={progress} done={done} error={error} deviceId={deviceId} inputError={inputError}/>;
 }
 const instance=render(<App/>,{exitOnCtrlC:false});
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));
  const url=initialUrl??await selected;
  const run=method==='device'?runDeviceSetupFlow:runSetupFlow;
  const result=await run(url,{onProgress:p=>updateProgress(p),signal:abort.signal});
  finish(result.deviceId);
  await new Promise(resolve=>setTimeout(resolve,850));
  return result;
 }catch(e){
  const error=e instanceof Error?e:new Error(String(e));
  fail(error.message);
  await new Promise(resolve=>setTimeout(resolve,1100));
  (error as Error&{setupScreenReported?:boolean}).setupScreenReported=true;
  throw error;
 }finally{instance.unmount();}
}
