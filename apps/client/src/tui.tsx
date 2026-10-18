import React, {useEffect, useMemo, useState} from 'react';
import {render, Box, Text, useInput, useApp, useStdout} from 'ink';
import {requestIpc, subscribeIpc} from './ipc.js';
import {activityPresentation, detailLines, safeText, duration, type ActivityEntry} from './presenter.js';
import {createDemoStatus, advanceDemo, demoHelp, type DemoScenario, type DemoStatus} from './demo.js';
import {cellWidth, fit, fitPath, oneLine, paneLayout, tableColumns, wrapLines} from './tui-layout.js';
import {copyText} from './clipboard.js';

type Task={id:string;description:string;start:number;kind:'foreground'|'background';
 actorName?:string|null;grantId?:string;requestJson?:string|null;cwd?:string|null};
type Transfer={id:string;status:string;bytes:number;path:string;totalBytes?:number;start?:number};
type Status={
 state:string;deviceName:string;deviceId:string;server?:string;uptimeMs:number;
 memoryBytes:number;availableMemoryBytes:number;totalMemoryBytes:number;
 cpuPercent:number;latencyMs:number|null;operationsTotal:number;
 active:Task[];transfers:Transfer[];activity:ActivityEntry[];
};
type LocalTask={id:string;title:string;start:number;kind:string;entry:ActivityEntry|undefined;progress?:number};
type OutputPage={text:string;nextOffset:number;totalBytes:number;hasMore:boolean;stream:string};
type Focus='activity'|'detail'|'tasks';
const palette={text:'#D6D6D6',muted:'#969696',line:'#5E5E5E',accent:'#75D9CF',selection:'#303030'};
const stateColor={running:'#EFC778',success:'#92D6A2',failed:'#F58D91',stopped:'#A6A6A6',unknown:'#A6A6A6'};
const spinnerFrames=['⣾','⣷','⣯','⣟','⡿','⢿','⣻','⣽'] as const;
const barTheme={
 connected:{background:'#BCE6C6',foreground:'#164D2A'},
 connecting:{background:'#F4D99B',foreground:'#614900'},
 disconnected:{background:'#F2B9B9',foreground:'#692526'},
};
const time=(value:number)=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false});
function SpinnerCell({color}:{color:string}){
 const [frame,setFrame]=useState(0);
 useEffect(()=>{
  const timer=setInterval(()=>setFrame(current=>(current+1)%spinnerFrames.length),80);
  return()=>clearInterval(timer);
 },[]);
 return <Text color={color}>{spinnerFrames[frame]+' '}</Text>;
}
function RunningElapsedCell({entry,color,bold,width}:{entry:ActivityEntry;color:string;bold:boolean;width:number}){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{
  const timer=setInterval(()=>setNow(Date.now()),100);
  return()=>clearInterval(timer);
 },[]);
 return <Text color={color} bold={bold}>{fit(activityPresentation(entry,now).elapsed,width)+' '}</Text>;
}
function useSize(){
 const {stdout}=useStdout();const term=stdout as NodeJS.WriteStream;
 const [size,setSize]=useState({w:term.columns||100,h:term.rows||30});
 useEffect(()=>{
  const resize=()=>setSize({w:Math.max(1,term.columns||100),h:Math.max(1,term.rows||30)});
  term.on('resize',resize);return()=>{term.off('resize',resize);};
 },[term]);
 return size;
}
function Title({label,right='',width,active=false,junctionAt}:{label:string;right?:string;width:number;active?:boolean;junctionAt?:number|undefined}){
 const title=oneLine(label),status=oneLine(right);
 const lead=width>=8?'━━ ':'';
 const tail=width>=8?'━━':width>=5?'─':'';
 const leadWidth=cellWidth(lead),tailWidth=cellWidth(tail);
 const minTitle=Math.min(3,cellWidth(title));
 let statusWidth=Math.min(cellWidth(status),Math.floor(width*.4));
 let hasStatus=Boolean(status)&&statusWidth>0;
 let titleWidth=width-leadWidth-tailWidth-(hasStatus?statusWidth+3:2)-1;
 if(hasStatus&&titleWidth<minTitle){
  hasStatus=false;statusWidth=0;
  titleWidth=width-leadWidth-tailWidth-2;
 }
 titleWidth=Math.max(0,Math.min(cellWidth(title),titleWidth));
 if(junctionAt!==undefined&&junctionAt>=leadWidth&&junctionAt<width-tailWidth)
  titleWidth=Math.min(titleWidth,Math.max(0,junctionAt-leadWidth-1));
 if(junctionAt!==undefined&&hasStatus){
  const statusRoom=width-leadWidth-tailWidth-titleWidth-4;
  if(statusRoom<1){hasStatus=false;statusWidth=0;}
  else statusWidth=Math.min(statusWidth,statusRoom);
 }
 const ruleWidth=Math.max(0,width-leadWidth-tailWidth-titleWidth-(hasStatus?statusWidth+3:1));
 const ruleStart=leadWidth+titleWidth+1,ruleOffset=junctionAt===undefined?-1:junctionAt-ruleStart;
 const rule='━'.repeat(ruleWidth);
 const joinedRule=ruleOffset>=0&&ruleOffset<ruleWidth?
  rule.slice(0,ruleOffset)+'┷'+rule.slice(ruleOffset+1):rule;
 return <Box height={1} flexShrink={0} width={width}>
  <Text color={palette.line}>{lead}</Text>
  <Text bold color={active?palette.accent:palette.muted}>{fit(title,titleWidth,false)}</Text>
  <Text color={palette.line}>{' '+joinedRule}</Text>
  {hasStatus?<Text color={palette.muted}>{' '+fit(status,statusWidth,false)+' '}</Text>:null}
  <Text color={palette.line}>{tail}</Text>
 </Box>;
}
function Line({text,width,color=palette.text,bold=false}:{text:string;width:number;color?:string;bold?:boolean}){
 return <Box height={1} flexShrink={0}><Text color={color} bold={bold}>{fit(text,width)}</Text></Box>;
}

export function App({demoScenario}:{demoScenario?:DemoScenario}={}){
 const demo=demoScenario!==undefined;
 const [demoStatus,setDemoStatus]=useState<DemoStatus|null>(()=>demoScenario?createDemoStatus(demoScenario):null);
 const {exit}=useApp(),{w,h}=useSize();
 const [liveStatus,setLiveStatus]=useState<Status|null>(null);
 const status:Status|null=demo?demoStatus:liveStatus;
 const [tick,setTick]=useState(Date.now());
 const [mountedAt]=useState(Date.now);
 const [focus,setFocus]=useState<Focus>('activity');
 // IDs keep selection stable when new activity arrives or running rows move.
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const [pinnedEntry,setPinnedEntry]=useState<ActivityEntry|null>(null);
 const [taskId,setTaskId]=useState<string|null>(null);
 const [detailTask,setDetailTask]=useState(false);
 const [view,setView]=useState<'main'|'help'|'config'>('main');
 const [edit,setEdit]=useState<'command'|'search'|null>(null);
 const [text,setText]=useState(''),[query,setQuery]=useState('');
 const [notice,setNotice]=useState('');
 const [confirm,setConfirm]=useState<string[]|null>(null);
 const [detailScroll,setDetailScroll]=useState(0);
 const [outputMode,setOutputMode]=useState(false);
 const [stream,setStream]=useState<'stdout'|'stderr'>('stdout');
 const [offsets,setOffsets]=useState([0]);
 const [output,setOutput]=useState<OutputPage|null>(null);
 const [outputError,setOutputError]=useState('');
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const timer=setInterval(()=>setTick(Date.now()),1000);
  return()=>clearInterval(timer);
 },[]);
 useEffect(()=>{
  if(demo)return;
  let alive=true,unsubscribe=()=>{};let retry:ReturnType<typeof setTimeout>|undefined;
  const listen=()=>{unsubscribe=subscribeIpc(next=>{
   if(alive)setLiveStatus(next as Status);
  },()=>{if(alive){setNotice('正在恢复本地连接…');retry=setTimeout(listen,2000);}});};
  listen();
  let samplePending=false;
  const sampleTimer=setInterval(()=>{
   if(samplePending)return;
   samplePending=true;
   void requestIpc({action:'status'},2000).then(next=>{if(alive)setLiveStatus(next as Status);})
    .catch(()=>{}).finally(()=>{samplePending=false;});
  },1000);
  return()=>{alive=false;unsubscribe();if(retry)clearTimeout(retry);clearInterval(sampleTimer);};
 },[demo]);
 const activeQuery=edit==='search'?text:query;
 const activities=useMemo(()=>{
  const needle=activeQuery.toLowerCase();
  return (status?.activity??[]).filter(a=>!needle||
   [a.tool,a.description,a.cwd,a.actor_name,a.grant_id,activityPresentation(a,0).target].join(' ').toLowerCase().includes(needle))
   .sort((a,b)=>Number(b.status==='running')-Number(a.status==='running')||b.time-a.time);
 },[status?.activity,activeQuery]);
 const currentSelection=activities.find(a=>a.id===selectedId);
 useEffect(()=>{if(selectedId&&currentSelection)setPinnedEntry(currentSelection);},[selectedId,currentSelection]);
 const selected=edit==='search'?activities[0]:selectedId?(currentSelection??(pinnedEntry?.id===selectedId?pinnedEntry:activities[0])):activities[0];
 const selectedIndex=activities.findIndex(a=>a.id===selected?.id);
 const tasks:LocalTask[]=[...(status?.active??[]).filter(t=>t.kind==='background').map(t=>({
  id:t.id,title:t.description,start:t.start,kind:'background',entry:status?.activity.find(a=>a.id===t.id)??{
   id:t.id,grant_id:t.grantId??'',actor_name:t.actorName??null,tool:'exec_background',description:t.description,
   status:'running',time:t.start,request_json:t.requestJson??null,cwd:t.cwd??null}})),
  ...(status?.transfers??[]).filter(t=>t.status==='running').map(t=>({
   id:t.id,title:t.path,start:t.start??tick,kind:'transfer',entry:undefined,
   ...(t.totalBytes?{progress:Math.min(100,Math.max(0,Math.round(t.bytes/t.totalBytes*100)))}:{})}))];
 const task=tasks.find(t=>t.id===taskId)??tasks[0];
 useEffect(()=>{
  if(!tasks.length){if(focus==='tasks')setFocus('activity');setDetailTask(false);}
 },[tasks.length,focus]);
 const taskIndex=Math.max(0,tasks.findIndex(t=>t.id===task?.id));
 const taskEntry=task?{...(task.entry??{id:task.id,grant_id:'',tool:task.kind==='transfer'?'transfer_upload':'exec_background',description:task.title}),
  status:'running',time:task.start,finished_at:null,duration_ms:null}:undefined;
 const entry=detailTask?taskEntry:selected;
 const model=entry?activityPresentation(entry,tick):null;
 const wideFooter=w>=112;
 const footerRows=wideFooter?1:2;
 const taskSlots=Math.min(tasks.length,h>=22?3:h>=16?2:1);
 const taskHeight=1+taskSlots;
 const bodyHeight=Math.max(1,h-4-taskHeight-footerRows);
 const layout=paneLayout(w,bodyHeight,h);
 const horizontal=layout.sideBySide,aw=layout.activityWidth,dw=layout.detailWidth;
 const tableRows=Math.max(1,layout.activityHeight-2);
 const rows:(ActivityEntry|'divider')[]=[];
 activities.forEach((a,index)=>{
  if(index>0&&a.status!=='running'&&activities[index-1]?.status==='running')rows.push('divider');
  rows.push(a);
 });
 const selectedRow=Math.max(0,rows.findIndex(a=>a!=='divider'&&a.id===selected?.id));
 const rowStart=Math.max(0,selectedRow-tableRows+1);
 const page=rows.slice(rowStart,rowStart+tableRows);
 const columns=tableColumns(Math.max(1,aw-2));
 const detailRows=Math.max(1,layout.detailHeight-2);
 const pageOffset=offsets[offsets.length-1]??0;
 useEffect(()=>{
  setDetailScroll(0);setOffsets([0]);setOutput(null);setOutputError('');
 },[entry?.id,stream]);
 useEffect(()=>{
  if(!outputMode||!entry)return;
  let alive=true;setOutput(null);setOutputError('');
  if(demo){
   let result:Record<string,unknown>={};try{result=JSON.parse(entry.result??'{}');}catch{}
   const value=String(result[stream]??'');
   setOutput({text:value,nextOffset:Buffer.byteLength(value),totalBytes:Buffer.byteLength(value),hasMore:false,stream});
   return;
  }
  void requestIpc({action:'output',operationId:entry.id,stream,byteOffset:pageOffset,maxBytes:16384})
   .then(result=>{if(alive)setOutput(result as OutputPage);})
   .catch(error=>{if(alive)setOutputError(safeText(String(error),200));});
  return()=>{alive=false;};
 },[demo,outputMode,entry?.id,stream,pageOffset,refresh]);
 const detail=useMemo(()=>{
  if(view==='help')return wrapLines([
   '键盘操作','↑↓ / j k 选择记录；详情内滚动','PgUp / PgDn 翻页；Home / End 首尾',
   'Tab 在活动、详情、后台之间切换','Enter 打开详情；Esc 返回活动',
   '/ 搜索（Agent / 工具 / 路径 / 意图）','> 命令面板；f 跟随最新记录',
   'o 查看本地完整输出；e 切换 stdout / stderr',
   '[ / ] 上一页 / 下一页输出；r 刷新输出','y 复制命令，非命令记录复制目标',
   'x 停止选中任务；X 停止全部进程（需确认）','q 关闭界面；? 帮助',
   ...(demo?demoHelp:[])],Math.max(1,dw-2));
  if(view==='config')return wrapLines(['连接信息',status?.deviceName??'等待本地 Runtime',
   status?.server??'', '后台服务：deskbeacon service start / stop / restart'],Math.max(1,dw-2));
  if(!entry||!model)return ['选择活动记录以查看参数与结果。'];
  const heading=[model.tool+' · '+model.status+' · '+model.elapsed];
  if(outputMode)return wrapLines([...heading,
   '本地日志 · '+stream+' · '+(output?output.totalBytes+' B · offset '+pageOffset:'读取中…'),
   ...(outputError?[outputError]:output?[(output.text||'(empty)')]:[])],Math.max(1,dw-2));
  return wrapLines([...heading,'',...detailLines(entry)],Math.max(1,dw-2));
 },[entry,model?.state,model?.elapsed,outputMode,output,outputError,pageOffset,view,dw,status?.deviceName,status?.server,demo]);
 const scroll=Math.min(detailScroll,Math.max(0,detail.length-detailRows));
 const resetDetail=()=>{setDetailScroll(0);setOutputMode(false);setView('main');};
 const move=(delta:number,edge?:'first'|'last')=>{
  if(focus==='detail'){
   setDetailScroll(x=>edge==='first'?0:edge==='last'?Math.max(0,detail.length-detailRows):Math.max(0,Math.min(detail.length-detailRows,x+delta)));
  }else if(focus==='tasks'){
   const index=edge==='first'?0:edge==='last'?tasks.length-1:Math.max(0,Math.min(tasks.length-1,taskIndex+delta));
   setTaskId(tasks[index]?.id??null);setDetailTask(true);resetDetail();
  }else{
   const index=edge==='first'?0:edge==='last'?activities.length-1:Math.max(0,Math.min(activities.length-1,selectedIndex+delta));
   setSelectedId(activities[index]?.id??null);setDetailTask(false);resetDetail();
  }
 };
 const stop=async(ids:string[])=>{
  setConfirm(null);
  if(demo){
   setDemoStatus(prev=>prev?{...prev,active:prev.active.filter(t=>!ids.includes(t.id)),
    activity:prev.activity.map(a=>ids.includes(a.id)?{...a,status:'cancelled',finished_at:tick,duration_ms:tick-a.time}:a)}:prev);
   setNotice('DEMO · 已模拟停止 '+ids.length+' 个任务');return;
  }
  const results=await Promise.allSettled(ids.map(taskId=>requestIpc({action:'stop',taskId})));
  const stopped=results.filter(r=>r.status==='fulfilled'&&r.value?.stopped===true).length;
  setNotice('已发送停止信号 '+stopped+'/'+ids.length+(stopped<ids.length?' · 其余任务已结束或停止失败':''));
 };
 useInput((input,key)=>{
  if(edit){
   if(key.escape){setEdit(null);setText('');return;}
   if(key.return){
    const value=text.trim(),kind=edit;setEdit(null);setText('');
    if(kind==='search'){setQuery(value);setSelectedId(null);setDetailTask(false);setFocus('activity');resetDetail();return;}
    if(value==='help'){setView('help');setFocus('detail');setDetailScroll(0);return;}
    if(value==='config'){setView('config');setFocus('detail');setDetailScroll(0);return;}
    if(value==='tasks'){
     if(tasks.length){setFocus('tasks');setDetailTask(true);resetDetail();}
     else setNotice('当前没有后台任务');
     return;
    }
    if(value==='clear'){setQuery('');setSelectedId(null);return;}
    if(value==='quit'||value==='exit'){exit();return;}
    setNotice('可用命令：help · config · tasks · clear · quit');return;
   }
   if(key.backspace||key.delete){setText(s=>Array.from(s).slice(0,-1).join(''));return;}
   if(input&&!key.ctrl&&!key.meta)setText(s=>(s+oneLine(input)).slice(0,256));
   return;
  }
  if(confirm){
   if(input==='y'||key.return){void stop(confirm);return;}
   if(input==='n'||key.escape)setConfirm(null);
   return;
  }
  if(input==='q'||(key.ctrl&&input==='c')){exit();return;}
  if(key.escape){
   if(view!=='main'||outputMode){resetDetail();return;}
   if(query){setQuery('');setSelectedId(null);return;}
   setFocus('activity');setDetailTask(false);return;
  }
  if(demo&&/^[0-9]$/.test(input)){
   setDemoStatus(prev=>prev?advanceDemo(prev,input):prev);setNotice('DEMO · 场景 '+input);return;
  }
  if(input==='/'||input==='s'){setEdit('search');setText(query);setNotice('');return;}
  if(input==='>'){setEdit('command');setText('');setNotice('');return;}
  if(input==='?'){setView(v=>v==='help'?'main':'help');setFocus('detail');setDetailScroll(0);return;}
  if(key.tab){
   const order:Focus[]=tasks.length?['activity','detail','tasks']:['activity','detail'];
   const index=order.indexOf(focus),delta=key.shift?-1:1;
   const next=order[(Math.max(0,index)+delta+order.length)%order.length]!;
   setFocus(next);if(next==='tasks')setDetailTask(true);else if(next==='activity')setDetailTask(false);
   else if(selected&&selectedId===null)setSelectedId(selected.id);
   return;
  }
  if(key.upArrow||input==='k'){move(-1);return;}
  if(key.downArrow||input==='j'){move(1);return;}
  if(key.pageUp){move(-(focus==='detail'?detailRows:tableRows));return;}
  if(key.pageDown){move(focus==='detail'?detailRows:tableRows);return;}
  if(key.home){move(0,'first');return;}
  if(key.end){move(0,'last');return;}
  if(key.return){setFocus('detail');setDetailTask(focus==='tasks'||detailTask);if(selected&&selectedId===null)setSelectedId(selected.id);return;}
  if(input==='f'){setSelectedId(null);setFocus('activity');setDetailTask(false);resetDetail();return;}
  if(input==='x'){
   const id=focus==='tasks'?task?.id:entry?.id;
   if(id&&(status?.active??[]).some(t=>t.id===id))setConfirm([id]);
   else setNotice('此记录没有可停止的运行进程');
   return;
  }
  if(input==='X'){
   const ids=[...new Set((status?.active??[]).map(t=>t.id))];
   if(ids.length)setConfirm(ids);else setNotice('当前没有运行中的进程');
   return;
  }
  if(input==='y'&&model){
   const value=model.command||model.target;
   if(demo){setNotice('DEMO · 复制预览：'+value);return;}
   void copyText(value).then(()=>setNotice(model.command?'已复制命令预览':'已复制目标')).catch(e=>setNotice(String(e)));return;
  }
  if(input==='o'&&entry){setOutputMode(x=>!x);setFocus('detail');setDetailScroll(0);setOffsets([0]);if(selected&&selectedId===null)setSelectedId(selected.id);return;}
  if(input==='e'&&outputMode){setStream(x=>x==='stdout'?'stderr':'stdout');return;}
  if(input===']'&&outputMode&&output?.hasMore){setOffsets(x=>[...x,output.nextOffset]);setDetailScroll(0);return;}
  if(input==='['&&outputMode){setOffsets(x=>x.length>1?x.slice(0,-1):x);setDetailScroll(0);return;}
  if(input==='r'&&outputMode){setRefresh(x=>x+1);return;}
 });
 const connected=status?.state==='connected',connecting=!status||status.state==='connecting';
 const connection=connected?'connected':connecting?'connecting':'offline';
 const headerTheme=connected?barTheme.connected:connecting?barTheme.connecting:barTheme.disconnected;
 const host=(()=>{try{return new URL(status?.server??'').host;}catch{return status?.deviceName??'local runtime';}})();
 const taskStart=Math.max(0,taskIndex-taskSlots+1);
 const activityPane=<Box flexDirection="column" width={aw} height={layout.activityHeight} overflow="hidden">
  <Title label={'ACTIVITY '+activities.length} width={aw} right={selectedId===null?'● live':selectedIndex<0?'历史快照':(selectedIndex+1)+' / '+activities.length} active={focus==='activity'}/>
  <Box height={1} paddingX={1} flexShrink={0}><Text color={palette.muted}>{'  '+columns.map(c=>fit(c.title,c.width-1)+' ').join('')}</Text></Box>
  {page.length?page.map(row=>row==='divider'?<Line key="divider" width={aw} text=" ┄ 以上运行中 · 以下为历史 ┄" color={palette.line}/>:(()=>{
   const a=activityPresentation(row,tick),isSelected=row.id===selected?.id;
   return <Box key={row.id} height={1} flexShrink={0} paddingX={1} backgroundColor={isSelected?palette.selection:undefined}>
    <Text color={isSelected?palette.accent:palette.muted}>{isSelected?'▸ ':'  '}</Text>
    {columns.map(c=>{
     const color=c.key==='state'?stateColor[a.state]:c.key==='elapsed'||c.key==='time'?palette.muted:palette.text;
     if(c.key==='state'&&a.state==='running')return <SpinnerCell key={c.key} color={color}/>;
     if(c.key==='elapsed'&&a.state==='running')return <RunningElapsedCell key={c.key} entry={row}
      color={color} bold={isSelected} width={c.width-1}/>;
     const value=c.key==='target'&&['fs_read','fs_write','fs_edit','fs_list','workspace_open','workspace_cd'].includes(row.tool)?
      fitPath(a.target,c.width-1):fit(c.key==='time'?time(row.time):c.key==='state'?a.symbol:
       c.key==='summary'?(a.state==='running'?a.intent:a.summary||a.intent):a[c.key],c.width-1);
     return <Text key={c.key} color={color} bold={isSelected}>{value+' '}</Text>;
    })}
   </Box>;
  })()):<Line width={aw} text={query?' 没有匹配记录 · Esc 清除筛选':' 暂无操作，等待 Agent 请求'} color={palette.muted}/>}
 </Box>;
 const detailPane=<Box flexDirection="column" width={dw} height={layout.detailHeight} overflow="hidden">
  <Title label={view==='help'?'HELP':view==='config'?'CONNECTION':outputMode?'LOCAL OUTPUT':'DETAIL'} width={dw} active={focus==='detail'}
   right={detail.length>detailRows?(scroll+1)+' / '+detail.length:''}/>
  <Box flexDirection="column" paddingX={1} height={detailRows} overflow="hidden">
   {detail.slice(scroll,scroll+detailRows).map((line,i)=><Line key={scroll+i} text={line} width={Math.max(1,dw-2)}
    color={scroll+i===0&&model?stateColor[model.state]:line.startsWith('stdout')||line.startsWith('stderr')?palette.accent:palette.text} bold={scroll+i===0}/>)}
  </Box>
  <Line width={dw} text={outputMode?' [ ] 翻页 · e 切换流 · r 刷新 · Esc 返回':' y 复制预览 · o 本地输出 · ↑↓ 滚动'} color={palette.muted}/>
 </Box>;
 const ramTotalBytes=status?.totalMemoryBytes??0;
 const ramUsedBytes=Math.max(0,ramTotalBytes-(status?.availableMemoryBytes??0));
 const ramText=ramTotalBytes>0?(ramUsedBytes/1073741824).toFixed(1)+'/'+
  (ramTotalBytes/1073741824).toFixed(1)+'GB':'—/—GB';
 const uptimeMs=(status?.uptimeMs??0)+(demo?Math.max(0,tick-mountedAt):0);
 const metrics='CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+ramText+' · '+(status?.operationsTotal??0)+' ops · up '+duration(uptimeMs);
 const compactHeader=w<56;
 const headerBrand=compactHeader?' DeskBeacon':' ((·)) DeskBeacon'+(demo&&w>=65?' · DEMO':'');
 const headerLeftWidth=Math.min(w,compactHeader?12:demo&&w>=65?34:26);
 const headerRightWidth=Math.max(0,w-headerLeftWidth);
 const footerPrompt=confirm?
  '停止 '+confirm.length+' 个进程及其子进程？ y / Enter 确认 · n / Esc 返回':
  notice||(w<64?'q 退出 · ? 帮助 · ↑↓ 选择 · Tab 切换 · / 搜索':'↑↓ 选择 · Tab 切换 · / 搜索 · x 停止 · ? 帮助 · q 退出');
 const compactMetrics=w<40?'CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+ramText:
  w<72?'CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+ramText+' · '+(status?.operationsTotal??0)+' ops':metrics;
 const footerRightWidth=wideFooter?Math.min(64,Math.max(48,Math.floor(w*.48))):0;
 const footerLeftWidth=wideFooter?w-footerRightWidth:w;
 if(w<24||h<12)return <Box width={w} height={h} flexDirection="column" overflow="hidden">
  <Line text="((·)) DeskBeacon" width={w}/><Line text="终端过小，请放大到 24×12" width={w}/><Line text="q 退出" width={w}/>
 </Box>;
 return <Box flexDirection="column" width={w} height={h} overflow="hidden">
  <Box height={1} flexShrink={0} width={w} backgroundColor={headerTheme.background} justifyContent="space-between">
   <Text bold color={headerTheme.foreground}>{fit(headerBrand,headerLeftWidth)}</Text>
   <Text color={headerTheme.foreground}>{fit('● '+connection+' · '+(status?.latencyMs??'—')+' ms · '+host,headerRightWidth,false)}</Text>
  </Box>
  <Box height={3} flexShrink={0} borderStyle="single" borderColor={edit?palette.accent:palette.line} paddingX={1}>
   <Text color={edit?palette.accent:palette.muted}>{fit(edit?(edit==='search'?'⌕ ':'> ')+text+'▏':
    query?'⌕ '+query+' · '+activities.length+' matches · Esc 清除':'⌕ / 搜索事件 · > 命令 · ? 帮助',Math.max(1,w-4))}</Text>
  </Box>
  <Box width={w} height={bodyHeight} flexShrink={0} flexDirection={horizontal?'row':'column'} overflow="hidden">
   {activityPane}
   {horizontal?<Box width={1} height={bodyHeight}><Text color={palette.line}>{Array.from({length:bodyHeight},(_,i)=>i===0?'┯':'│').join('\n')}</Text></Box>:
    <Line text={'─'.repeat(w)} width={w} color={palette.line}/>}
   {detailPane}
  </Box>
  <Box flexDirection="column" height={taskHeight} flexShrink={0} overflow="hidden">
   <Title label={'BACKGROUND '+tasks.length} width={w} active={focus==='tasks'} junctionAt={horizontal?aw:undefined}
    right={tasks.length>taskSlots?(taskIndex+1)+' / '+tasks.length:''}/>
   {tasks.slice(taskStart,taskStart+taskSlots).map(t=>{
    const chosen=t.id===task?.id&&detailTask;
    const agent=t.entry?activityPresentation(t.entry,tick).agent:'—';
    return <Box key={t.id} height={1} paddingX={1} flexShrink={0} backgroundColor={chosen?palette.selection:undefined}>
     <Text color={chosen?palette.accent:stateColor.running}>{chosen?'▸ ':'● '}</Text>
     <Text color={palette.muted}>{fit(t.id.slice(0,8),9)}</Text>
     {w>=80?<Text color={palette.text}>{fit(agent,12)}</Text>:null}
     <Text color={palette.muted}>{fit(t.progress!==undefined?t.progress+'%':duration(tick-t.start),9)}</Text>
     <Text color={palette.text}>{fit(t.entry?activityPresentation(t.entry,tick).target:t.title,Math.max(1,w-(w>=80?34:22)))}</Text>
    </Box>;
   })}
  </Box>
  {wideFooter?<Box height={1} width={w} flexShrink={0} backgroundColor="#2D61B7">
   <Box height={1} width={footerLeftWidth} flexShrink={0}>
    <Text color="white" bold>{fit(' '+footerPrompt,footerLeftWidth)}</Text>
   </Box>
   <Box height={1} width={footerRightWidth} flexShrink={0} paddingRight={1} justifyContent="flex-end">
    <Text color="#FFFFFF" bold>{fit(metrics,Math.max(1,footerRightWidth-1),false)}</Text>
   </Box>
  </Box>:<Box flexDirection="column" height={2} width={w} flexShrink={0}>
   <Box height={1} width={w} flexShrink={0} paddingRight={1} backgroundColor="#1C1C1C">
    <Text color={palette.muted}>{fit(footerPrompt,Math.max(1,w-1))}</Text>
   </Box>
   <Box height={1} width={w} flexShrink={0} paddingRight={1} backgroundColor="#2D61B7">
    <Text color="#FFFFFF" bold>{fit(' '+compactMetrics,Math.max(1,w-1))}</Text>
   </Box>
  </Box>
  }
 </Box>;
}

export async function showTui(demoScenario?:DemoScenario){
 if(process.stdout.isTTY)process.stdout.write('\x1b[?1049h');
 try{
  const app=render(demoScenario?<App demoScenario={demoScenario}/>:<App/>,{interactive:process.stdout.isTTY===true});
  await app.waitUntilExit();
 }finally{
  if(process.stdout.isTTY)process.stdout.write('\x1b[?1049l');
 }
}
