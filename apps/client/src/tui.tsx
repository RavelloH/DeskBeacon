import React, {useEffect, useMemo, useState} from 'react';
import {render, Box, Text, useInput, useApp, useStdout} from 'ink';
import {requestIpc, subscribeIpc} from './ipc.js';
import {actionLabel, argumentLines, resultLines, safeText, duration, type ActivityEntry} from './presenter.js';

type Task={id:string;description:string;start:number;kind:'foreground'|'background'};
type Transfer={id:string;status:string;bytes:number;path:string;totalBytes?:number};
type Status={
 state:string;deviceName:string;deviceId:string;uptimeMs:number;
 memoryBytes:number;cpuPercent:number;latencyMs:number|null;operationsTotal:number;
 active:Task[];transfers:Transfer[];activity:ActivityEntry[];
};
const colors={
 connected:['#BCE6C6','#164D2A'],connecting:['#F4D99B','#614900'],
 disconnected:['#F2B9B9','#692526']
};
function useSize(){
 const {stdout}=useStdout();const term=stdout as NodeJS.WriteStream;
 const [size,setSize]=useState({w:term.columns||100,h:term.rows||30});
 useEffect(()=>{
   const resize=()=>setSize({w:term.columns||100,h:term.rows||30});
   term.on('resize',resize);return()=>{term.off('resize',resize);};
 },[term]);
 return size;
}
const clock=(time:number)=>new Date(time).toLocaleTimeString('zh-CN',{hour12:false});
export function App(){
 const {exit}=useApp(),{w,h}=useSize();
 const [status,setStatus]=useState<Status|null>(null);
 const [tick,setTick]=useState(Date.now());
 const [focus,setFocus]=useState<'activity'|'tasks'>('activity');
 const [cursor,setCursor]=useState(0),[taskCursor,setTaskCursor]=useState(0);
 const [view,setView]=useState<'main'|'help'|'config'>('main');
 const [edit,setEdit]=useState<'command'|'search'|null>(null);
 const [text,setText]=useState(''),[query,setQuery]=useState('');
 const [open,setOpen]=useState<Record<string,boolean>>({});
 const [notice,setNotice]=useState(''),[confirm,setConfirm]=useState<string|null>(null);
 const [expandedTasks,setExpandedTasks]=useState(false);
 useEffect(()=>{
   let alive=true,unsubscribe=()=>{};let retry:ReturnType<typeof setTimeout>|undefined;
   const listen=()=>{unsubscribe=subscribeIpc(next=>{
     if(alive){setStatus(next as Status);setNotice('');}
   },()=>{if(alive){setNotice('正在恢复本地连接…');retry=setTimeout(listen,2000);}});
   };
   listen();
   const tickTimer=setInterval(()=>setTick(Date.now()),1000);
   const sampleTimer=setInterval(()=>{
     void requestIpc({action:'status'},2000).then(next=>{if(alive)setStatus(next as Status);}).catch(()=>{});
   },12000);
   return()=>{alive=false;unsubscribe();if(retry)clearTimeout(retry);clearInterval(tickTimer);clearInterval(sampleTimer);};
 },[]);
 const activities=useMemo(()=>(status?.activity??[]).filter(a=>
   !query||(a.tool+' '+a.description+' '+a.cwd+' '+a.grant_id).toLowerCase().includes(query.toLowerCase())),
   [status?.activity,query]);
 const jobs=(status?.active??[]).filter(t=>t.kind==='background');
 const transfers=(status?.transfers??[]).filter(t=>t.status==='running');
 const tasks=[...jobs.map(t=>({...t,title:t.description})),
   ...transfers.map(t=>({...t,title:t.path,start:tick,kind:'transfer'}))];
 const maxTasks=expandedTasks?Math.min(tasks.length,Math.max(1,h-14)):Math.min(5,tasks.length);
 const displayedTasks=tasks.length>5&&!expandedTasks?tasks.slice(0,4):tasks.slice(0,maxTasks);
 const omitted=tasks.length>5&&!expandedTasks?tasks.length-4:0;
 const taskRows=tasks.length===0?0:Math.min(5,displayedTasks.length+(omitted?1:0));
 const bodyRows=Math.max(5,h-taskRows-3);
 const visible=Math.max(1,Math.floor((bodyRows-1)/7));
 const start=Math.max(0,cursor-visible+1);
 const page=activities.slice(start,start+visible);
 const connected=status?.state==='connected';
 const connecting=!status||status.state==='connecting';
 const key=connected?'connected':connecting?'connecting':'disconnected';
 const [bg,fg]=colors[key] as [string,string];
 const logo=connected?'((·))':connecting?'((!))':'((x))';
 const info=connected?'已连接':connecting?'正在连接':'等待重连';
 const ping=connected?'连接成功 · '+(status?.latencyMs??'—')+' ms':
   connecting?'正在建立连接':'WebSocket 已断开';
 const lineWidth=Math.max(25,w-6);
 const stop=(id:string)=>{void requestIpc({action:'stop',taskId:id}).then(()=>{
   setConfirm(null);setNotice('已停止任务 '+id.slice(0,8));
 }).catch(e=>setNotice(safeText(String(e),70)));};
 useInput((input,key)=>{
   if(edit){
     if(key.escape){setEdit(null);setText('');return;}
     if(key.return){
       const value=text.trim(),kind=edit;setEdit(null);setText('');
       if(kind==='search'){setQuery(value);setCursor(0);return;}
       if(value==='help'){setView('help');return;}
       if(value==='config'){setView('config');return;}
       if(value==='tasks'){setExpandedTasks(true);setFocus('tasks');return;}
       if(value==='clear'){setQuery('');return;}
       if(value==='quit'||value==='exit'){exit();return;}
       if(value.startsWith('stop ')){setConfirm(value.slice(5).trim());return;}
       setNotice('未知命令: /'+value);return;
     }
     if(key.backspace||key.delete){setText(s=>s.slice(0,-1));return;}
     if(input&&!key.ctrl&&!key.meta)setText(s=>s+input);
     return;
   }
   if(view!=='main'){if(key.escape||input==='q')setView('main');return;}
   if(confirm){
     if(input==='y'||key.return){stop(confirm);return;}
     if(input==='n'||key.escape){setConfirm(null);return;}
     return;
   }
   if(key.escape){setQuery('');setExpandedTasks(false);return;}
   if(input==='q'||(key.ctrl&&input==='c')){exit();return;}
   if(input==='?'){setView('help');return;}
   if(input==='/'){setEdit('command');return;}
   if(input==='s'){setEdit('search');setText(query);return;}
   if(key.tab){setFocus(x=>x==='activity'?'tasks':'activity');return;}
   if(key.upArrow||input==='k'){
     if(focus==='activity')setCursor(x=>Math.max(0,x-1));
     else setTaskCursor(x=>Math.max(0,x-1));
     return;
   }
   if(key.downArrow||input==='j'){
     if(focus==='activity')setCursor(x=>Math.min(Math.max(0,activities.length-1),x+1));
     else setTaskCursor(x=>Math.min(Math.max(0,tasks.length-1),x+1));
     return;
   }
   if(input==='x'){
     const id=focus==='tasks'?tasks[taskCursor]?.id:activities[cursor]?.id;
     if(id&&(status?.active??[]).some(t=>t.id===id))setConfirm(id);
     return;
   }
   if(key.return){
     if(focus==='activity'){
       const id=activities[cursor]?.id;
       if(id)setOpen(prev=>({...prev,[id]:!prev[id]}));
     }else if(omitted&&taskCursor>=4)setExpandedTasks(true);
     else if(tasks[taskCursor])setConfirm(tasks[taskCursor]!.id);
   }
 });
 const footer='CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+Math.round((status?.memoryBytes??0)/1048576)+'MB · '+(status?.operationsTotal??0)+' 项操作';
 const footerRight='运行 '+duration(status?.uptimeMs??0)+' · '+(status?.active??[]).length+' 个进程';
 const entry=(a:ActivityEntry,i:number)=>{
   const selected=focus==='activity'&&start+i===cursor;
   const more=!!open[a.id],args=argumentLines(a),output=resultLines(a);
   const argsShown=more?10:2,resultShown=more?14:5;
   const elapsed=a.status==='running'?tick-a.time:a.duration_ms??(a.finished_at??a.time)-a.time;
   return <Box key={a.id} flexDirection="column" marginBottom={1} paddingLeft={1}>
     <Box justifyContent="space-between">
       <Text bold color={selected?'cyan':'white'}>{selected?'> ':'  '}{safeText(a.actor_name||'Agent '+a.grant_id.slice(0,8),28)}
         <Text dimColor>{' · '+safeText(a.cwd||'',Math.max(10,Math.floor(w/2)))}</Text>
       </Text>
       <Text color="gray">{clock(a.time)} · {duration(elapsed)}</Text>
     </Box>
     <Text color={a.status==='running'?'yellow':a.status==='failed'?'red':'green'} bold>
       {'  '+(a.status==='running'?'~ ':a.status==='failed'?'! ':'+ ')+actionLabel(a)}
       {a.description&&a.description!==a.tool?<Text dimColor italic>{' · '+safeText(a.description,Math.max(18,w-35))}</Text>:null}
     </Text>
     {args.slice(0,argsShown).map((line,n)=>
       <Text key={'in'+n} color={line.startsWith('+')?'green':line.startsWith('-')?'red':'gray'}>{'  '+safeText(line,lineWidth)}</Text>)}
     {args.length>argsShown?<Text color="gray">{'  ... 折叠 '+(args.length-argsShown)+' 行参数'}</Text>:null}
     {output.slice(0,resultShown).map((line,n)=>
       <Text key={'out'+n} color={line.startsWith('+')?'green':line.startsWith('-')?'red':'white'}>{'  '+safeText(line,lineWidth)}</Text>)}
     {output.length>resultShown?<Text color="gray">{'  ... 折叠 '+(output.length-resultShown)+' 行结果 · Enter 展开'}</Text>:null}
   </Box>;
 };
 return <Box flexDirection="column" width={w} height={h}>
   <Box height={1} width="100%" backgroundColor={bg} justifyContent="space-between">
     <Text bold color={fg}>{' '+logo+' '+info}</Text>
     <Text bold color={fg}>DeskBeacon</Text>
     <Text color={fg}>{safeText(ping,Math.max(14,Math.floor(w/3)))+' '}</Text>
   </Box>
   <Box height={bodyRows} flexDirection="column" paddingX={1} flexGrow={1}>
     {view==='help'?<Box flexDirection="column">
       <Text bold color="cyan">快捷键</Text>
       {['↑↓ / j k    选择上一条、下一条','Tab          切换操作和长期任务',
         'Enter        展开记录或选择任务','s            搜索操作历史',
         '/            输入命令','x            终止任务（需确认）','?            帮助','q            关闭窗口','Esc          返回'].map(x=><Text key={x}>{x}</Text>)}
     </Box>:view==='config'?<Box flexDirection="column">
       <Text bold color="cyan">设置 /config</Text>
       <Text>当前连接: {status?.deviceName||'未配置'}</Text>
       <Text>后台服务: deskbeacon service start / stop / restart</Text>
       <Text dimColor>开机自启和运行模式切换稍后在此开放。</Text>
     </Box>:<>
       <Text dimColor>{query?'搜索 '+safeText(query)+' · ':''}{focus==='activity'?'ACTIVITY':'TASKS'} · {activities.length} 项 · ? 帮助</Text>
       {page.length?page.map(entry):<Text dimColor>暂无操作记录</Text>}
     </>}
   </Box>
   {taskRows>0?<Box height={taskRows} backgroundColor="#30343C" flexDirection="column" paddingX={1}>
     {displayedTasks.map((task,i)=><Box key={task.id} justifyContent="space-between">
       <Text bold={focus==='tasks'&&taskCursor===i} color={focus==='tasks'&&taskCursor===i?'cyan':'white'}>
         {focus==='tasks'&&taskCursor===i?'> ':'  '}{safeText(task.title,Math.max(16,w-20))}
       </Text>
       <Text color="gray">{duration(tick-task.start)} {'[x]'}</Text>
     </Box>)}
     {omitted>0?<Text color="gray">{'  ... 另外 '+omitted+' 个任务 · Enter 展开'}</Text>:null}
   </Box>:null}
   <Box width="100%" height={1} backgroundColor="#1A1C22" paddingX={1}>
     <Text color="gray">{edit==='search'?'搜索 > '+text:edit==='command'?'/'+text:
       confirm?'停止 '+confirm.slice(0,8)+' ? [y/n]':notice||'s 搜索 · / 命令 · x 停止 · q 退出'}</Text>
   </Box>
   <Box width="100%" height={1} backgroundColor="#2D61B7" justifyContent="space-between">
     <Text color="white" bold>{' '+footer}</Text>
     <Text color="white" bold>{footerRight+' '}</Text>
   </Box>
 </Box>;
}
export async function showTui(){
 if(process.stdout.isTTY)process.stdout.write('\x1b[?1049h');
 try{
   const app=render(<App/>);
   await app.waitUntilExit();
 }finally{
   if(process.stdout.isTTY)process.stdout.write('\x1b[?1049l');
 }
}
