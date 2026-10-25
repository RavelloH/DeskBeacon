import type {OutputPreview} from '@deskbeacon/protocol';
import {loadSelectedOutputPreview} from './selected-output-preview.js';
import React, {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {render, Box, Text, useInput, useApp, useStdout} from 'ink';
import {LiveIpcClient,type LiveEvent} from './ipc-live.js';
import {backgroundWindow} from './background-window.js';
import {activityPresentation, safeText, duration, elapsedText, type ActivityEntry} from './presenter.js';
import {toolRow, type Segment, type Tone} from './tool-presentation.js';
import {detailPresentation, wrapDetail, numberedBlock, type DetailLine} from './detail-presentation.js';
import {inspectorInput,inspectorResult,inspectorOutput,inspectorCopyText,storedOutputLimited,type InspectorTab,type FullSource} from './detail-inspector.js';
import {readEntireLocalStream} from './local-stream.js';
import {loadSelectedFilePreview,missingSelectedFileSource,withSelectedFilePreview,type SelectedFilePreview} from './selected-file-preview.js';
import {terminalWindowTitle,writeTerminalTitle} from './terminal-title.js';
import {activityFileLink,openActivityFile,decodeSgrMouse} from './action-link.js';
import {logEvent,flushLogs} from './diagnostics.js';
import {TuiInputBridge,stripMouseControlText} from './tui-input.js';
import {installTuiTerminalGuard} from './tui-terminal-guard.js';
import type {EventEmitter} from 'node:events';
import {ACTIVITY_PAGE_SIZE, sortActivityRows, compatibleDayStats, type ActivityPage, type ActivityDayStats} from './activity-query.js';
import {createDemoStatus, advanceDemo, demoHelp, type DemoScenario, type DemoStatus} from './demo.js';
import {cellWidth, fit, oneLine, paneLayout, tableColumns, detailScrollStatus, wrapLines, rightFit, activityTime, dateDivider, dateKey, type Column} from './tui-layout.js';
import {copyText} from './clipboard.js';
import {commandPalette,parseCommand,type Option} from './command-palette.js';

type Task={id:string;description:string;start:number;kind:'foreground'|'background';
 actorName?:string|null;grantId?:string;requestJson?:string|null;cwd?:string|null};
type Transfer={id:string;status:string;bytes:number;path:string;totalBytes?:number;start?:number};
type Status={
 state:string;deviceName:string;deviceId:string;server?:string;runtimeMode?:string;uptimeMs:number;
 memoryBytes:number;availableMemoryBytes:number;totalMemoryBytes:number;
 cpuPercent:number;latencyMs:number|null;operationsTotal:number;activityRevision?:number;
 active:Task[];transfers:Transfer[];activity?:ActivityEntry[];
};
type LocalTask={id:string;title:string;start:number;kind:string;entry:ActivityEntry|undefined;progress?:number};
type TaskLog={id:string;line:string};
type OutputPage={text:string;nextOffset:number;totalBytes:number;hasMore:boolean;stream:string};
type Focus='activity'|'detail'|'tasks';
// The bottom bar is for app-wide navigation. Inspector-only controls live in DETAIL.
const globalShortcuts=(width:number)=>width<64?
 's 搜索 · / 指令 · f 最新 · x 停止 · q 退出':width<140?
 'Tab 切换 · s 搜索 · / 指令 · f 最新 · x 停止 · q 退出':
 '↑↓ 选择 · Tab 切换 · s 搜索 · / 指令 · f 最新 · x 停止 · q 退出';
const palette={text:'#D6D6D6',muted:'#969696',line:'#5E5E5E',accent:'#75D9CF',selection:'#303030'};
const stateColor={running:'#EFC778',success:'#92D6A2',failed:'#F58D91',stopped:'#A6A6A6',interrupted:'#EFC778',unknown:'#A6A6A6'};
const spinnerFrames=['⣾','⣷','⣯','⣟','⡿','⢿','⣻','⣽'] as const;
const barTheme={
 connected:{background:'#BCE6C6',foreground:'#164D2A'},
 connecting:{background:'#F4D99B',foreground:'#614900'},
 disconnected:{background:'#F2B9B9',foreground:'#692526'},
};
const time=(value:number)=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false});
const toneColor:Record<Tone,string>={default:palette.text,muted:palette.muted,success:stateColor.success,danger:stateColor.failed,warning:stateColor.running,accent:palette.accent};
function liveElapsed(ms:number){
 const elapsed=Math.max(0,ms),totalSeconds=Math.floor(elapsed/1000);
 if(totalSeconds===0)return Math.floor(elapsed)+'ms';
 const minutes=Math.floor(totalSeconds/60),seconds=totalSeconds%60;
 if(minutes===0)return totalSeconds+'s';
 if(minutes<60)return minutes+'m'+String(seconds).padStart(2,'0')+'s';
 return Math.floor(minutes/60)+'h'+String(minutes%60).padStart(2,'0')+'m'+String(seconds).padStart(2,'0')+'s';
}
// All visible spinners and sub-second elapsed labels share one animation clock.
// Per-cell intervals previously triggered separate full Ink layout / ANSI diff
// passes, even though the frames are identical.
let animationFrame=0;
const animationSubscribers=new Set<()=>void>();
let animationTimer:ReturnType<typeof setInterval>|undefined;
function subscribeAnimation(onChange:()=>void){
 animationSubscribers.add(onChange);
 if(!animationTimer)animationTimer=setInterval(()=>{
  animationFrame=(animationFrame+1)%spinnerFrames.length;
  for(const subscriber of animationSubscribers)subscriber();
 },200);
 return ()=>{
  animationSubscribers.delete(onChange);
  if(!animationSubscribers.size&&animationTimer){
   clearInterval(animationTimer);
   animationTimer=undefined;
  }
 };
}
const animationSnapshot=()=>animationFrame;
function useAnimationFrame(){
 return useSyncExternalStore(subscribeAnimation,animationSnapshot,()=>0);
}
function SpinnerCell({color}:{color:string}){
 const frame=useAnimationFrame();
 return <Text color={color}>{spinnerFrames[frame]+' '}</Text>;
}
function RunningElapsedCell({entry,color,bold,width}:{entry:ActivityEntry;color:string;bold:boolean;width:number}){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[]);
 return <Text color={color} bold={bold}>{rightFit(liveElapsed(now-entry.time),width)+' '}</Text>;
}
function RunningDetailHeading({entry,tool,status,width}:{entry:ActivityEntry;tool:string;status:string;width:number}){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[]);
 return <Line text={tool+' · '+status+' · '+liveElapsed(now-entry.time)} width={width} color={stateColor.running} bold/>;
}
function BackgroundTable({tasks,start,slots,hidden,logs,width,height,focus,selectedId,horizontal,activityWidth}:{
 tasks:LocalTask[];start:number;slots:number;hidden:number;logs:Record<string,string>;width:number;height:number;focus:boolean;selectedId:string|null;
 horizontal:boolean;activityWidth:number;
}){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{if(!tasks.length)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[tasks.length>0]);
 const contentWidth=Math.max(1,width-2),iconWidth=Math.min(2,contentWidth);
 const visible=tasks.slice(start,start+slots);
 return <Box flexDirection="column" width={width} height={height} flexShrink={0} overflow="hidden">
  <Title label={'BACKGROUND '+tasks.length} width={width} active={focus} junctionAt={horizontal?activityWidth:undefined}
   right={tasks.length>slots?(start+visible.length)+' / '+tasks.length:''}/>
  {tasks.length>0?visible.map(task=>{
    const chosen=task.id===selectedId;
    const model=task.entry?activityPresentation(task.entry,now):undefined;
    const tool=model?.tool??(task.kind==='transfer'?'传输':'后台');
    const agent=model?.agent??'—';
    const intent=model?.intent??task.title;
    const log=logs[task.id]?.trim()||'';
    const elapsed=liveElapsed(now-task.start);
    const started=contentWidth-iconWidth>=36?time(task.start):new Date(task.start).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
    const leftText=[started,agent,tool,intent].join('   ');
    const elapsedWidth=Math.min(cellWidth(elapsed),Math.min(10,Math.max(1,contentWidth-iconWidth-2)));
    const leftWidth=Math.max(0,contentWidth-iconWidth-elapsedWidth-1);
    return <Box key={task.id} height={1} width={width} paddingX={1} flexShrink={0}
     backgroundColor={chosen?palette.selection:undefined}>
     <SpinnerCell color={chosen?palette.accent:stateColor.running}/>
     {leftWidth>0?<><Text color={chosen?palette.accent:palette.text} bold={chosen}>{fit(leftText,log?Math.max(12,Math.floor(leftWidth*.68)):leftWidth,false)}</Text>{log?<Text color={palette.muted}>{fit('   '+log,Math.max(0,leftWidth-Math.max(12,Math.floor(leftWidth*.68))),false)}</Text>:null}</>:null}
     <Box flexGrow={1}/>
     <Text color={palette.muted}>{' '+fit(elapsed,elapsedWidth,false)}</Text>
    </Box>;
   }):null}
  {hidden>0?<Box height={1} width={width} paddingX={1}><Text color={palette.muted}>{fit('…以及剩余 '+hidden+' 个 · ↑↓ / 滚轮查看',Math.max(1,width-2))}</Text></Box>:null}
 </Box>;
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
function Title({label,right='',rightColor,width,active=false,junctionAt}:{label:string;right?:string;rightColor?:string|undefined;width:number;active?:boolean;junctionAt?:number|undefined}){
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
  {hasStatus?<Text color={rightColor??palette.muted}>{' '+fit(status,statusWidth,false)+' '}</Text>:null}
  <Text color={palette.line}>{tail}</Text>
 </Box>;
}
function Line({text,width,color=palette.text,bold=false}:{text:string;width:number;color?:string;bold?:boolean}){
 return <Box height={1} flexShrink={0}><Text color={color} bold={bold}>{fit(text,width)}</Text></Box>;
}

/** Real two-column layout: the explanation never shifts with command length.
 * The divider belongs to its own Ink Box, not spaces padded into a Text. */
function CommandCandidateRow({option,width,active}:{option:Option;width:number;active:boolean}){
 const nameWidth=Math.max(14,Math.min(39,Math.floor(width*.29)));
 const descriptionWidth=Math.max(1,width-nameWidth-2);
 return <Box width={width} height={1} flexShrink={0} overflow="hidden"
   backgroundColor={active?palette.selection:undefined}>
   <Box width={nameWidth} height={1} flexShrink={0} paddingLeft={1} overflow="hidden">
    <Text color={active?palette.accent:option.selectable?palette.text:palette.muted}>
     {fit((active?'› ':'  ')+option.label,Math.max(1,nameWidth-1),false)}
    </Text>
   </Box>
   <Box width={1} height={1} flexShrink={0}>
    <Text color={palette.line}>│</Text>
   </Box>
   <Box width={width-nameWidth-1} height={1} flexShrink={0} paddingLeft={1} overflow="hidden">
    <Text color={palette.muted}>{fit(option.description,descriptionWidth,false)}</Text>
   </Box>
  </Box>;
}

/** Rich text clipped by terminal cells, never by UTF-16 length. */
function RichCell({segments,width,linkLabel,hovered=false}:{segments:Segment[];width:number;linkLabel?:string|undefined;hovered?:boolean|undefined}){
 let remaining=Math.max(0,width);
 const spans:{text:string;tone:Tone}[]=[];
 for(const segment of segments){
  if(remaining<=0)break;
  const raw=oneLine(segment.text);
  const fitted=fit(raw,remaining,false),used=cellWidth(fitted);
  spans.push({text:fitted,tone:segment.tone??'default'});
  remaining-=used;
  if(cellWidth(raw)>used)break;
 }
 return <Text>{spans.map((part,index)=>{
  const at=hovered&&linkLabel?part.text.indexOf(linkLabel):-1;
  if(at<0)return <Text key={index} color={toneColor[part.tone]}>{part.text}</Text>;
  return <Text key={index} color={toneColor[part.tone]}>{part.text.slice(0,at)}<Text underline color={palette.accent}>{part.text.slice(at,at+linkLabel!.length)}</Text>{part.text.slice(at+linkLabel!.length)}</Text>;
 })}{' '.repeat(remaining)+' '}</Text>;
}

/** The history list is normally static: a status/clock tick should not reparse
 * every visible row's request and result JSON or rerun unicode fitting. */
const ActivityTableRow=React.memo(function ActivityTableRow({record,columns,isSelected,timeAnchor,linkHovered}:{
 record:ActivityEntry;columns:Column[];isSelected:boolean;timeAnchor:number;linkHovered?:boolean;
}){
 const a=activityPresentation(record,timeAnchor),visual=toolRow(record);
 const link=linkHovered?activityFileLink(record):null;
 return <Box height={1} flexShrink={0} paddingX={1} backgroundColor={isSelected?palette.selection:undefined}>
  <Text color={isSelected?palette.accent:palette.muted}>{isSelected?'▸ ':'  '}</Text>
  {columns.map(c=>{
   const width=c.width-1;
   if(c.key==='action'||c.key==='result')return <RichCell key={c.key}
    segments={c.key==='action'?visual.action:visual.result} width={width}
    linkLabel={c.key==='action'?link?.label:undefined} hovered={c.key==='action'&&linkHovered}/>;
   const color=c.key==='state'?stateColor[a.state]:c.key==='elapsed'||c.key==='time'||(c.key==='tool'&&visual.readOnly)?palette.muted:palette.text;
   if(c.key==='state'&&a.state==='running')return <SpinnerCell key={c.key} color={color}/>;
   if(c.key==='elapsed'&&a.state==='running')return <RunningElapsedCell key={c.key}
    entry={record} color={color} bold={isSelected} width={width}/>;
   const value=c.key==='time'?activityTime(record.time,timeAnchor):c.key==='state'?a.symbol:
    c.key==='tool'?visual.toolLabel:a[c.key];
   const formatted=c.key==='elapsed'?rightFit(value,width):fit(value,width);
   return <Text key={c.key} color={color} bold={isSelected}>{formatted+' '}</Text>;
  })}
 </Box>;
});

/** Two-column form rendering: field labels, separator, and values use separate tones. */
const DetailCell=React.memo(function DetailCell({item,width}:{item:DetailLine;width:number}){
 if(item.section){
  // Thin, full-width divider. The next line holds the section label,
  // so section titles cannot be confused with focused pane headings.
  return <Box height={1} flexShrink={0} width={width}>
   <Text color={palette.line}>{'─'.repeat(Math.max(0,width))}</Text>
  </Box>;
 }
 const text=item.text;
 if(item.sourceLine!==undefined){
  // Reserve exactly as many columns as the highest logical line number in
  // this block. A soft wrap leaves the number blank, never adds a glyph.
  const digits=item.lineDigits??String(item.sourceLine??'?').length;
  // Pane separator │ + one inset cell + logical number + │ + one space.
  // Soft wraps retain the gutter but leave the number entirely blank.
  const gutter=' '+(item.continued?' '.repeat(digits):String(item.sourceLine??'?').padStart(digits))+' │ ';
  const room=Math.max(0,width-cellWidth(gutter));
  return <Box height={1} flexShrink={0} width={width}>
   <Text color={palette.line}>{gutter}</Text>
   {item.syntax?<Text>{item.syntax.map((segment,index)=><Text key={index} color={segment.color}>{segment.text}</Text>)}</Text>:
    <Text color={item.tone&&item.tone!=='default'?toneColor[item.tone]:palette.muted}
     bold={item.bold===true}>{fit(text,room)}</Text>}
  </Box>;
 }
 if(item.syntax){
  return <Box height={1} flexShrink={0} width={width}>
   <Text>{' '}</Text>
   <Text>{item.syntax.map((segment,index)=><Text key={index} color={segment.color}>{segment.text}</Text>)}</Text>
   <Text>{' '}</Text>
  </Box>;
 }
 if(item.label){
  const index=text.indexOf('│');
  if(index>=0){
   const prefix=text.slice(0,index),divider='│ ',value=text.slice(index+2);
   const room=Math.max(0,width-2-cellWidth(prefix)-cellWidth(divider));
   return <Box height={1} flexShrink={0} width={width}>
    <Text>{' '}</Text>
    <Text bold color="#FFFFFF">{prefix}</Text>
    <Text color={palette.line}>{divider}</Text>
    <Text color={item.tone&&item.tone!=='default'?toneColor[item.tone]:palette.muted} bold={item.bold===true} italic={item.italic===true}>{fit(value,room)}</Text>
    <Text>{' '}</Text>
   </Box>;
  }
 }
 return <Box height={1} flexShrink={0} width={width}>
  <Text>{' '}</Text>
  <Text color={item.tone&&item.tone!=='default'?toneColor[item.tone]:item.bold?'#FFFFFF':palette.muted} bold={item.bold===true} italic={item.italic===true}>{fit(text,Math.max(0,width-2))}</Text>
  <Text>{' '}</Text>
 </Box>;
});

/** The running duration advances independently of costly DETAIL rendering. */
function RunningDurationDetailCell({entry,item,width}:{entry:ActivityEntry;item:DetailLine;width:number}){
 useAnimationFrame();
 // The running duration only needs the start timestamp, not a full
 // activityPresentation() pass that reparses request/result JSON per frame.
 const elapsed=elapsedText(Date.now()-entry.time);
 return <DetailCell item={{...item,text:item.text.replace(/│.*/, '│ '+elapsed)}} width={width}/>;
}
declare const __DESKBEACON_RELEASE__:boolean;
const DEMO_ENABLED=typeof __DESKBEACON_RELEASE__==='undefined'||!__DESKBEACON_RELEASE__;
export function App({demoScenario,mouseEvents,terminalTitle='DeskBeacon',onIntentionalExit}:{demoScenario?:DemoScenario;mouseEvents?:EventEmitter;terminalTitle?:string;onIntentionalExit?:(reason:string)=>void}={}){
 const demo=DEMO_ENABLED&&demoScenario!==undefined;
 const [demoStatus,setDemoStatus]=useState<DemoStatus|null>(()=>demo&&demoScenario?createDemoStatus(demoScenario):null);
 const {exit}=useApp(),{w,h}=useSize();
 const [liveStatus,setLiveStatus]=useState<Status|null>(null);
 const ipcClientRef=useRef<LiveIpcClient|null>(null);
 const [ipcSession,setIpcSession]=useState(0);
 const [backgroundVersion,setBackgroundVersion]=useState(0);
 const [focusedVersion,setFocusedVersion]=useState(0);
 const [backgroundLogs,setBackgroundLogs]=useState<Record<string,string>>({});
 const visibleBackgroundIdsRef=useRef<Set<string>>(new Set());
 const focusedOutputIdRef=useRef<string|null>(null);
 const requestLocal=(request:object,timeoutMs=2500):Promise<any>=>{
  const client=ipcClientRef.current;
  return client?client.request(request as Record<string,unknown>,timeoutMs):Promise.reject(Error('IPC_DISCONNECTED'));
 };
 const status:Status|null=demo?demoStatus:liveStatus;
 const [loadedActivity,setLoadedActivity]=useState<ActivityEntry[]>(()=>demoStatus?.activity??[]);
 const activityDeviceRef=useRef<string|null>(null);
 const activityVersionRef=useRef<number|null>(null);
 const activityLoadGenerationRef=useRef(0);
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
 const [commandIndex,setCommandIndex]=useState(0);
 const [settings,setSettings]=useState<{name?:string|undefined;url?:string|undefined;pending?:boolean;activeUrl?:string;proxyAuto?:boolean;proxyUrl?:string|null}>({});
 const commandMenu=edit==='command'?commandPalette(text,{
   name:settings.name??status?.deviceName,url:settings.url??status?.server,proxyAuto:settings.proxyAuto,proxyUrl:settings.proxyUrl}):null;
 const commandOptions=commandMenu?.items??[];
 const commandSelect=Math.min(commandIndex,Math.max(0,commandOptions.length-1));
 useEffect(()=>{
  if(edit!=='command')return;
  if(demo){setSettings({name:status?.deviceName,url:status?.server});return;}
  let alive=true;
  void requestLocal({action:'config-get'},2500).then(result=>{if(alive)setSettings(result);})
   .catch(error=>{if(alive)setNotice('读取配置失败：'+String(error));});
  return()=>{alive=false;};
 },[edit,demo]);
 const [notice,setNotice]=useState('');
 const [ipcOfflineSince,setIpcOfflineSince]=useState<number|null>(null);
 const ipcOfflineRef=useRef(false);
 const [ipcDisconnectReason,setIpcDisconnectReason]=useState('');
 useEffect(()=>{
  writeTerminalTitle(terminalWindowTitle(terminalTitle,ipcOfflineSince!==null?'disconnected':status?.state??'connecting',status?.active?.length??0));
 },[terminalTitle,status?.state,status?.active?.length,ipcOfflineSince]);
 const [hoverLinkId,setHoverLinkId]=useState<string|null>(null);
 const [exitArmedAt,setExitArmedAt]=useState(0);
 const uptimeAnchorRef=useRef<{device:string;uptime:number;at:number}|null>(null);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),3200);return()=>clearTimeout(timer);},[notice]);
 const [confirm,setConfirm]=useState<string[]|null>(null);
 const [detailScroll,setDetailScroll]=useState(0);
 const [inspectorTab,setInspectorTab]=useState<InspectorTab>('summary');
 const [inspectorSource,setInspectorSource]=useState<FullSource|null>(null);
 const inspectorSourceRef=useRef<FullSource|null>(null);
 inspectorSourceRef.current=inspectorSource;
 const [inspectorError,setInspectorError]=useState('');
 const [inspectorProgress,setInspectorProgress]=useState('');
 const [selectedFilePreview,setSelectedFilePreview]=useState<SelectedFilePreview|null>(null);
 const [selectedOutputPreview,setSelectedOutputPreview]=useState<{id:string;preview:OutputPreview}|null>(null);
 const [liveLog,setLiveLog]=useState('');
 const [refresh,setRefresh]=useState(0);
 const [pageHasMore,setPageHasMore]=useState(false);
 const [pageLoading,setPageLoading]=useState(false);
 const [pageTotal,setPageTotal]=useState(0);
 // null means the attached Runtime predates database-wide daily aggregates.
 const [dayStats,setDayStats]=useState<ActivityDayStats[]|null>(null);
 const [pageError,setPageError]=useState('');
 const activityCursorRef=useRef<string|null>(null);
 const activityQueryRef=useRef<string|null>(null);
 const activityPageCountRef=useRef(0);
 const pendingActivityIndexRef=useRef<number|null>(null);
 const pageLoadingRef=useRef(false);
 const viewportStartRef=useRef(0);
 const wheelHandlerRef=useRef<(direction:number,x:number,y:number)=>void>(()=>{});
 const mouseHandlerRef=useRef<(event:ReturnType<typeof decodeSgrMouse>[number])=>void>(()=>{});
 const selectionIndexRef=useRef(0);
 const loadedActivityRef=useRef(loadedActivity);
 loadedActivityRef.current=loadedActivity;
 useEffect(()=>{
  const timer=setInterval(()=>setTick(Date.now()),1000);
  return()=>clearInterval(timer);
 },[]);
 useEffect(()=>{
  if(demo)return;
  let alive=true,client:LiveIpcClient|null=null,retry:ReturnType<typeof setTimeout>|undefined;
  let statusPending=false,statusDirty=false;
  const refresh=async()=>{
   if(!alive||!client)return;
   if(statusPending){statusDirty=true;return;}
   statusPending=true;
   try{
    const next=await client.request<Status>({action:'status-lite'},3500);
    if(alive&&ipcClientRef.current===client){
     setLiveStatus(next);
     setIpcOfflineSince(null);setIpcDisconnectReason('');
     ipcOfflineRef.current=false;
     setNotice(previous=>previous==='正在恢复本地连接…'?'':previous);
    }
   }catch{/* disconnection is handled by the socket */}
   finally{
    statusPending=false;
    if(statusDirty){statusDirty=false;void refresh();}
   }
  };
  const onEvent=(event:LiveEvent)=>{
   if(event.topic==='runtime.changed'||event.topic==='metrics.changed'){void refresh();return;}
   if(event.topic!=='output.changed'||!event.taskId)return;
   if(focusedOutputIdRef.current===event.taskId)setFocusedVersion(value=>value+1);
   if(visibleBackgroundIdsRef.current.has(event.taskId))setBackgroundVersion(value=>value+1);
  };
  const connect=async()=>{
   try{
    const opened=await LiveIpcClient.connect(onEvent,reason=>{
     if(!alive)return;
     if(client===opened){
      client=null;
      ipcClientRef.current=null;
      ipcOfflineRef.current=true;
      setIpcOfflineSince(previous=>previous??Date.now());
      setIpcDisconnectReason(reason);
      retry=setTimeout(()=>{void connect();},2000);
     }
    },2500);
    if(!alive){opened.close();return;}
    client=opened;ipcClientRef.current=opened;
    await opened.request({action:'watch',topics:['runtime','system.metrics']},3500);
    if(!alive||client!==opened)return;
    setIpcSession(value=>value+1);
    void refresh();
   }catch(error){
    if(!alive)return;
    client?.close();client=null;ipcClientRef.current=null;
    ipcOfflineRef.current=true;
    setIpcOfflineSince(previous=>previous??Date.now());
    setIpcDisconnectReason(String(error));
    if(retry)clearTimeout(retry);
    retry=setTimeout(()=>{void connect();},2000);
   }
  };
  void connect();
  return()=>{alive=false;if(retry)clearTimeout(retry);client?.close();ipcClientRef.current=null;};
 },[demo]);
 const activeQuery=edit==='search'?text:query;
 useEffect(()=>{
  if(!status)return;
  if(demo){
   activityDeviceRef.current=status.deviceId;
   setLoadedActivity(status.activity??[]);
   setPageTotal((status.activity??[]).length);
   setDayStats(null);
   setPageHasMore(false);
   return;
  }
  const changed=activityDeviceRef.current!==status.deviceId||activityQueryRef.current!==activeQuery;
  if(changed){
   activityDeviceRef.current=status.deviceId;
   activityQueryRef.current=activeQuery;
   activityVersionRef.current=null;
   activityCursorRef.current=null;
   activityPageCountRef.current=0;
   pageLoadingRef.current=false;
   setPageLoading(false);
   setLoadedActivity([]);
   setPageHasMore(true);
   setPageTotal(0);
   setDayStats(null);
   setSelectedId(null);
   setPinnedEntry(null);
   pendingActivityIndexRef.current=null;
  }
  const revision=status.activityRevision??0;
  if(!changed&&activityVersionRef.current===revision)return;
  activityVersionRef.current=revision;
  // A status revision must not invalidate an older-page request in progress.
  // Only a device or search change invalidates its pagination cursor.
  const generation=changed?++activityLoadGenerationRef.current:activityLoadGenerationRef.current;
  let alive=true,retry:ReturnType<typeof setTimeout>|undefined;
  const load=()=>{
   const watchIds=changed?[]:loadedActivityRef.current.filter(a=>a.status==='running').map(a=>a.id).slice(0,100);
   void requestLocal({action:'activity-list',limit:ACTIVITY_PAGE_SIZE,query:activeQuery,watchIds},10000)
    .then((page:ActivityPage)=>{
     if(!alive||generation!==activityLoadGenerationRef.current)return;
     const replace=changed||activityPageCountRef.current<=1;
     setLoadedActivity(previous=>{
      if(replace)return sortActivityRows(page.rows as ActivityEntry[]);
      const merged=new Map(previous.map(item=>[item.id,item]));
      for(const record of [...page.rows,...page.updates] as ActivityEntry[])merged.set(record.id,record);
      return sortActivityRows([...merged.values()]);
     });
     if(replace){
      activityCursorRef.current=page.nextCursor;
      activityPageCountRef.current=1;
      setPageHasMore(page.hasMore);
     }
     setPageTotal(page.total);
     setDayStats(compatibleDayStats(page.days));
     setPageError('');
    }).catch(error=>{
     if(!alive||generation!==activityLoadGenerationRef.current)return;
     setPageError(safeText(String(error),120));
     retry=setTimeout(load,2000);
    });
  };
  const delay=changed&&edit==='search'?180:0;
  if(delay)retry=setTimeout(load,delay);else load();
  return()=>{alive=false;if(retry)clearTimeout(retry);};
 },[demo,status?.deviceId,status?.activityRevision,status?.activity,activeQuery]);
 const activities=useMemo(()=>{
  if(!demo)return loadedActivity;
  const needle=activeQuery.toLowerCase();
  return sortActivityRows(loadedActivity.filter(a=>!needle||
   [a.tool,a.description,a.cwd,a.actor_name,a.grant_id,activityPresentation(a,0).target].join(' ').toLowerCase().includes(needle)));
 },[loadedActivity,activeQuery,demo]);
 const loadNextPage=()=>{
  if(demo||!pageHasMore||pageLoadingRef.current||!activityCursorRef.current)return;
  const generation=activityLoadGenerationRef.current,cursor=activityCursorRef.current;
  pageLoadingRef.current=true;setPageLoading(true);
  void requestLocal({action:'activity-list',limit:ACTIVITY_PAGE_SIZE,query:activityQueryRef.current??'',cursor},10000)
   .then((page:ActivityPage)=>{
    if(generation!==activityLoadGenerationRef.current)return;
    setLoadedActivity(previous=>{
     const merged=new Map(previous.map(item=>[item.id,item]));
     for(const record of page.rows as ActivityEntry[])merged.set(record.id,record);
     return sortActivityRows([...merged.values()]);
    });
    activityCursorRef.current=page.nextCursor;
    activityPageCountRef.current++;
    setPageHasMore(page.hasMore);
    setPageTotal(page.total);
    setDayStats(compatibleDayStats(page.days));
    setPageError('');
   }).catch(error=>{
    if(generation===activityLoadGenerationRef.current)setPageError(safeText(String(error),120));
   }).finally(()=>{
    if(generation===activityLoadGenerationRef.current){pageLoadingRef.current=false;setPageLoading(false);}
   });
 };
 const currentSelection=activities.find(a=>a.id===selectedId);
 useEffect(()=>{if(selectedId&&currentSelection)setPinnedEntry(currentSelection);},[selectedId,currentSelection]);
 const selected=edit==='search'?activities[0]:selectedId?(currentSelection??(pinnedEntry?.id===selectedId?pinnedEntry:activities[0])):activities[0];
 const selectedIndex=activities.findIndex(a=>a.id===selected?.id);
 selectionIndexRef.current=selectedIndex;
 const tasks:LocalTask[]=[...(status?.active??[]).filter(t=>t.kind==='background').map(t=>{
  const activity=loadedActivity.find(a=>a.id===t.id);
  return {id:t.id,title:t.description,start:t.start,kind:'background',entry:activity?{
   ...activity,actor_name:activity.actor_name??t.actorName??null}: {
   id:t.id,grant_id:t.grantId??'',actor_name:t.actorName??null,tool:'exec_background',description:t.description,
   status:'running',time:t.start,request_json:t.requestJson??null,cwd:t.cwd??null}};
 }),
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
 const baseEntry=detailTask?taskEntry:selected;
 // Fetch full saved I/O for the selected file operation only, never the full list.
 useEffect(()=>{
  setSelectedFilePreview(null);
  if(demo||!baseEntry||view!=='main'||!missingSelectedFileSource(baseEntry))return;
  let alive=true;
  const timer=setTimeout(()=>{
   void loadSelectedFilePreview(baseEntry,request=>requestLocal(request,8000))
    .then(preview=>{if(alive)setSelectedFilePreview(preview);})
    .catch(()=>{if(alive)setSelectedFilePreview(null);});
  },130);
  return()=>{alive=false;clearTimeout(timer);};
 },[demo,baseEntry?.id,baseEntry?.tool,baseEntry?.request_json,baseEntry?.result,detailTask,view,ipcSession]);
 // A selected DETAIL preview is fetched on demand (4 KiB), not hydrated for
 // every ACTIVITY row. The OUTPUT inspector continues to page the full log.
 useEffect(()=>{
  setSelectedOutputPreview(null);
  if(demo||!baseEntry||view!=='main'||baseEntry.status==='running'||
     !['exec_foreground','exec_background'].includes(baseEntry.tool))return;
  let alive=true;
  let clipped=false;
  try{const r=JSON.parse(baseEntry.result??'{}');clipped=r.outputLimit===true||r.data?.outputLimit===true;}catch{}
  void loadSelectedOutputPreview(baseEntry.id,request=>requestLocal(request,8000),4096,!clipped)
   .then(preview=>{if(alive&&preview)setSelectedOutputPreview({id:baseEntry.id,preview});})
   .catch(()=>{});
  return()=>{alive=false;};
 },[demo,baseEntry?.id,baseEntry?.status,view,ipcSession]);
 const entry=useMemo(()=>{
  const item=baseEntry?withSelectedFilePreview(baseEntry,selectedFilePreview):undefined;
  if(!item||selectedOutputPreview?.id!==item.id)return item;
  let result:Record<string,unknown>={};
  try{result=JSON.parse(item.result??'{}');}catch{}
  const preview=selectedOutputPreview.preview;
  return {...item,result:JSON.stringify({...result,outputPreview:preview.text,
   outputPreviewKind:'head_tail',outputPreviewMeta:preview,
   previewTruncated:preview.truncated,outputPreviewOmittedBytes:preview.omittedBytes})};
 },[baseEntry,selectedFilePreview,selectedOutputPreview]);
 // Completed entries are immutable between activity revisions; do not parse their JSON on each clock tick.
 const model=useMemo(()=>entry?activityPresentation(entry,entry.status==='running'?tick:0):null,
  [entry,entry?.status==='running'?tick:0]);
 const wideFooter=w>=112;
 const footerRows=wideFooter?1:2;
 const footerWindow=backgroundWindow(tasks,taskIndex,h>=22?5:h>=16?3:2);
 const taskSlots=footerWindow.visible.length;
 const taskHeight=1+footerWindow.rows;
 const visibleBackgroundIds=footerWindow.visible.filter(task=>task.kind==='background').map(task=>task.id);
 const visibleBackgroundKey=visibleBackgroundIds.join('\0');
 visibleBackgroundIdsRef.current=new Set(visibleBackgroundIds);
 const focusedOutputId=entry?.status==='running'&&['exec_foreground','exec_background'].includes(entry.tool)?entry.id:null;
 focusedOutputIdRef.current=focusedOutputId;
 const watchedOutputIds=[...new Set([...visibleBackgroundIds,...(focusedOutputId?[focusedOutputId]:[])])];
 const watchedOutputKey=watchedOutputIds.join('\0');
 useEffect(()=>{
  if(demo)return;
  const client=ipcClientRef.current;
  if(!client)return;
  void client.request({action:'output.watchSet',taskIds:watchedOutputIds},5000).catch(()=>{});
 },[demo,ipcSession,watchedOutputKey]);
 useEffect(()=>{
  if(demo||!visibleBackgroundIds.length){setBackgroundLogs({});return;}
  let alive=true;
  void requestLocal({action:'task-logs',taskIds:visibleBackgroundIds},2500)
   .then((rows:TaskLog[])=>{if(!alive)return;
    const next=Object.fromEntries(rows.map(item=>[item.id,item.line]));
    setBackgroundLogs(previous=>{
     const same=Object.keys(previous).length===Object.keys(next).length&&
      Object.keys(next).every(id=>previous[id]===next[id]);
     return same?previous:next;
    });
   }).catch(()=>{});
  return()=>{alive=false;};
 },[demo,ipcSession,visibleBackgroundKey,backgroundVersion]);
 const visibleOptions=Math.max(1,Math.min(8,h-4-taskHeight-footerRows-8));
 const paletteCount=Math.min(visibleOptions,Math.max(1,commandOptions.length));
 const commandPanelHeight=edit==='command'?paletteCount+2:0;
 const bodyHeight=Math.max(1,h-4-taskHeight-footerRows-commandPanelHeight);
 // TIME labels only change when the activity list changes or local midnight passes.
 // A 2200-row scan takes ~118ms, so never repeat it for each status/clock update.
 const localDay=dateKey(tick);
 const timeAnchor=useMemo(()=>tick,[localDay]);
 const longestTime=useMemo(()=>activities.reduce((max,a)=>Math.max(max,cellWidth(activityTime(a.time,timeAnchor))),8),
  [activities,timeAnchor]);
 const layout=paneLayout(w,bodyHeight,h,longestTime+1);
 const horizontal=layout.sideBySide,aw=layout.activityWidth,dw=layout.detailWidth;
 const tableRows=Math.max(1,layout.activityHeight-2);
 useEffect(()=>{
  if(!demo&&focus==='activity'&&selectedId!==null&&pageHasMore&&
   selectedIndex>=activities.length-Math.max(4,tableRows))loadNextPage();
 },[demo,focus,selectedId,selectedIndex,activities.length,pageHasMore,tableRows]);
 useEffect(()=>{
  const index=pendingActivityIndexRef.current;
  if(index===null)return;
  if(index<activities.length){
   pendingActivityIndexRef.current=null;
   setSelectedId(activities[index]?.id??null);
  }else if(!pageHasMore&&!pageLoading){
   pendingActivityIndexRef.current=null;
  }
 },[activities.length,pageHasMore,pageLoading]);
 type ActivityRow=ActivityEntry|{kind:'date';timestamp:number};
 // Keep pagination counts and day headers stable during every clock tick and wheel event.
 const {rows,dailyCounts}=useMemo(()=>{
  const counts=new Map<string,{total:number;success:number;failed:number;running:number}>();
  const list:ActivityRow[]=[];
  activities.forEach((a,index)=>{
   const key=dateKey(a.time),v=counts.get(key)??{total:0,success:0,failed:0,running:0};
   v.total++;
   const state=activityPresentation(a,0).state;
   if(state==='running')v.running++;
   else if(state==='success')v.success++;
   else v.failed++;
   counts.set(key,v);
   const previous=activities[index-1];
   if(a.status!=='running'&&(!previous||previous.status==='running'||dateKey(previous.time)!==key))
    list.push({kind:'date',timestamp:a.time});
   list.push(a);
  });
  return {rows:list,dailyCounts:counts};
 },[activities]);
 const fullDayStats=useMemo(()=>new Map((dayStats??[]).map(day=>[day.date,day])),[dayStats]);
 const dailyLabel=(ts:number)=>{
  const legacy=demo||dayStats===null;
  const n=legacy?dailyCounts.get(dateKey(ts)):fullDayStats.get(dateKey(ts));
  return dateDivider(ts,timeAnchor)+' · '+(n?.total??0)+(legacy?' 已载入':' OPS')+' · '+(n?.success??0)+' OK · '+(n?.failed??0)+' FAIL'+
   (('interrupted' in (n??{}) && Number((n as ActivityDayStats).interrupted)>0)?' · '+(n as ActivityDayStats).interrupted+' INT':'')+
   (n?.running?' · '+n.running+' RUN':'');
 };
 const selectedRow=Math.max(0,rows.findIndex(a=>!('kind' in a)&&a.id===selected?.id));
 const viewport=viewportStartRef.current;
 const rowStart=selectedId===null?0:selectedRow<viewport?selectedRow:selectedRow>=viewport+tableRows?selectedRow-tableRows+1:viewport;
 viewportStartRef.current=Math.max(0,Math.min(rowStart,Math.max(0,rows.length-tableRows)));
 const visibleRows=rows.slice(rowStart,rowStart+tableRows);
 const columns=useMemo(()=>tableColumns(Math.max(1,aw-2),longestTime+1,layout.detailGain),
  [aw,longestTime,layout.detailGain]);
 const detailRows=Math.max(1,layout.detailHeight-(inspectorTab==='summary'?2:3));
 useEffect(()=>{setDetailScroll(0);setInspectorSource(null);setInspectorError('');},[entry?.id,inspectorTab]);
 useEffect(()=>{
  if(inspectorTab==='summary'||!entry)return;
  let alive=true;
  setInspectorError('');setInspectorSource(null);setInspectorProgress('');
  const mode=inspectorTab;
  if(demo){
   if(mode==='input'){
    const raw=entry.request_json??'';
    setInspectorSource({text:raw,totalBytes:Buffer.byteLength(raw),available:raw!=='',legacy:true});
   }else{
    let result:Record<string,unknown>={};try{result=JSON.parse(entry.result??'{}');}catch{}
    const raw=mode==='result'?(entry.result??''):String(result[mode]??'');
    setInspectorSource({text:raw,totalBytes:Buffer.byteLength(raw),available:true});
   }
   return;
  }
  const action=mode==='input'?'input':mode==='result'?'result':'output';
  void readEntireLocalStream(async byteOffset=>
    await requestLocal({action,operationId:entry.id,...(mode==='input'?{}:{stream:mode}),
      byteOffset,maxBytes:65536}) as OutputPage & {available?:boolean},
    (loaded,total)=>{if(alive&&total>65536)setInspectorProgress('已读取 '+loaded+' / '+total+' 字节');})
   .then(source=>{if(alive){
     setInspectorSource(source);
     if(mode==='input'&&!source.available)setInspectorProgress('旧版输入快照不可用');
     else setInspectorProgress('');
   }})
   .catch(error=>{if(alive){
     if(mode==='input'){
      setInspectorSource({text:'',totalBytes:0,available:false,legacy:true});
      setInspectorProgress('旧版输入快照不可用');
     }else setInspectorError(safeText(String(error),300));
   }});
  return()=>{alive=false;};
 },[demo,entry?.id,inspectorTab,refresh]);
 // Full I/O follows file growth using byte offsets; never reread the entire output on a timer.
 useEffect(()=>{
  if(demo||!entry||entry.status!=='running'||!['stdout','stderr'].includes(inspectorTab))return;
  const source=inspectorSourceRef.current;
  if(!source||!source.available)return;
  let alive=true;
  const from=source.totalBytes,mode=inspectorTab,operationId=entry.id;
  void (async()=>{
   let offset=from,target:number|null=null;
   const pieces:string[]=[];
   for(;;){
    const page=await requestLocal({action:'output',operationId,stream:mode,byteOffset:offset,maxBytes:65536},5000) as OutputPage;
    if(target===null)target=page.totalBytes;
    if(page.nextOffset<=offset){if(offset<(target??0))throw Error('LOCAL_STREAM_STALLED');break;}
    pieces.push(page.text);offset=page.nextOffset;
    if(offset>=target)break;
   }
   if(!alive||offset===from)return;
   setInspectorSource(previous=>previous&&previous.totalBytes===from?
    {...previous,text:previous.text+pieces.join(''),totalBytes:offset}:previous);
  })().catch(error=>{if(alive)setInspectorError(safeText(String(error),120));});
  return()=>{alive=false;};
 },[demo,entry?.id,entry?.status,inspectorTab,focusedVersion,ipcSession,inspectorSource?.totalBytes]);
 useEffect(()=>{
  if(demo||inspectorTab!=='summary'||!entry||entry.status!=='running'||!['exec_foreground','exec_background'].includes(entry.tool)){
   setLiveLog('');return;
  }
  let alive=true;
  const stream='stdout';
  void requestLocal({action:'output-tail',operationId:entry.id,stream},2500)
   .then((page:OutputPage)=>{
    if(!alive)return;
    const next=page.text?.slice(-3500)??'';
    setLiveLog(previous=>previous===next?previous:next);
   }).catch(()=>{});
  return()=>{alive=false;};
 },[demo,entry?.id,entry?.status,entry?.tool,inspectorTab,focusedVersion,ipcSession]);
 const detailNow=entry?.status==='running'?Math.floor(tick/1000):0;
 const detail=useMemo(():DetailLine[]=>{
  const fromPlain=(lines:string[])=>wrapDetail(lines.map(text=>({text})),Math.max(1,dw-2));
  if(view==='config')return fromPlain(['连接信息',status?.deviceName??'等待本地 Runtime',
   status?.server??'', '后台服务：deskbeacon service start / stop / restart']);
  if(!entry||!model)return fromPlain(['选择活动记录以查看参数与结果。']);
  if(inspectorTab!=='summary'){
   const lines:DetailLine[]=inspectorError?[{text:inspectorError,tone:'danger'}]:
    inspectorTab==='input'?inspectorInput(entry,inspectorSource):
    inspectorTab==='result'?inspectorResult(entry,inspectorSource):
    inspectorOutput(inspectorSource,inspectorTab,undefined,storedOutputLimited(entry));
   return wrapDetail(inspectorProgress?[{text:inspectorProgress,tone:'muted'},...lines]:lines,Math.max(1,dw-2));
  }
  const lines=detailPresentation(entry,tick);
  if(liveLog&&entry.status==='running'){
   const preview:DetailLine[]=[{text:'LIVE OUTPUT',section:'LIVE OUTPUT',tone:'muted',bold:true}];
   // Live output is a tail; its actual first stream line is unknown.
   preview.push(...numberedBlock(liveLog,undefined,null,20,3500));
   const trace=lines.findIndex(row=>row.section==='TRACE');
   lines.splice(trace<0?lines.length:trace,0,...preview);
  }
  return wrapDetail(lines,Math.max(1,dw-2));
 },[entry?.id,entry?.status,entry?.result,entry?.request_json,model?.state,detailNow,liveLog,inspectorTab,inspectorSource,inspectorError,inspectorProgress,view,dw,status?.deviceName,status?.server,demo]);
 const scroll=Math.min(detailScroll,Math.max(0,detail.length-detailRows));
 const resetDetail=()=>{setDetailScroll(0);setInspectorTab('summary');setView('main');};
 const move=(delta:number,edge?:'first'|'last',target:Focus=focus)=>{
  if(target==='detail'){
   setDetailScroll(x=>edge==='first'?0:edge==='last'?Math.max(0,detail.length-detailRows):Math.max(0,Math.min(detail.length-detailRows,x+delta)));
  }else if(target==='tasks'){
   const index=edge==='first'?0:edge==='last'?tasks.length-1:Math.max(0,Math.min(tasks.length-1,taskIndex+delta));
   setTaskId(tasks[index]?.id??null);setDetailTask(true);resetDetail();
  }else{
   const requested=edge==='first'?0:edge==='last'?activities.length-1:Math.max(0,selectionIndexRef.current+delta);
   if(pageHasMore&&(edge==='last'||requested>=activities.length)){
    if(requested>=activities.length)pendingActivityIndexRef.current=requested;
    loadNextPage();
   }
   const index=Math.max(0,Math.min(activities.length-1,requested));
   selectionIndexRef.current=index;
   // Selecting the newest row in ACTIVITY enables continuous follow mode.
   setSelectedId(index===0&&!activeQuery?null:activities[index]?.id??null);setDetailTask(false);resetDetail();
  }
 };
 wheelHandlerRef.current=(direction,x,y)=>{
  if(confirm)return;
  if(edit==='command'){
   if(y>=6&&y<5+commandPanelHeight)
    setCommandIndex(i=>Math.max(0,Math.min(commandOptions.length-1,i+direction)));
   return;
  }
  if(edit)return;
  if(y>=5+commandPanelHeight&&y<5+commandPanelHeight+bodyHeight){
   if((horizontal&&x>aw)||(!horizontal&&y>5+layout.activityHeight)){
    setFocus('detail');setDetailScroll(n=>Math.max(0,Math.min(Math.max(0,detail.length-detailRows),n+direction)));
   }else{setFocus('activity');move(direction,undefined,'activity');}
  }else if(tasks.length&&y>=5+commandPanelHeight+bodyHeight&&y<5+commandPanelHeight+bodyHeight+taskHeight){
   setFocus('tasks');move(direction>0?1:-1,undefined,'tasks');
  }
 };
 useEffect(()=>{
  const listener=(event:ReturnType<typeof decodeSgrMouse>[number])=>{
   if(event.kind==='wheel')wheelHandlerRef.current(event.direction,event.x,event.y);
   else mouseHandlerRef.current(event);
  };
  mouseEvents?.on('mouse',listener);
  return()=>{mouseEvents?.off('mouse',listener);};
 },[mouseEvents]);
 mouseHandlerRef.current=event=>{
  if(edit==='command'&&event.y>=5&&event.y<5+commandPanelHeight){
   const firstVisible=Math.max(0,commandSelect-visibleOptions+1);
   const index=firstVisible+event.y-6,option=commandOptions[index];
   if(option?.selectable){
    if(event.kind==='move')setCommandIndex(index);
    if(event.kind==='press'&&event.button===0){setText(option.insert);setCommandIndex(0);}
   }
   return;
  }
  // The inspector's visible tabs are clickable as well as keyboard-accessible.
  if(event.kind==='press'&&event.button===0&&horizontal&&event.y===6&&
    event.x>aw&&inspectorTab!=='summary'&&edit!=='command'){
   const local=event.x-aw-1;
   const commandTool=entry&&['exec_foreground','exec_background'].includes(entry.tool);
   if(local>=0&&local<(commandTool?29:19)){
    setInspectorTab(local<9?'input':commandTool?(local<19?'stdout':'stderr'):'result');
    setDetailScroll(0);
   }
   return;
  }
  // Search occupies terminal rows 2–4; click to enter search editing.
  if(event.kind==='press'&&event.button===0&&event.y>=2&&event.y<=4){
   setEdit('search');setText(query);setNotice('');return;
  }
  if(event.y<7+commandPanelHeight||event.y>=7+commandPanelHeight+tableRows||(horizontal&&event.x>aw)){
   if(event.kind==='move')setHoverLinkId(null);
   return;
  }
  const record=visibleRows[event.y-7-commandPanelHeight];
  if(!record||'kind' in record){
   if(event.kind==='move')setHoverLinkId(null);
   return;
  }
  const actionIndex=columns.findIndex(column=>column.key==='action');
  const start=3+columns.slice(0,actionIndex).reduce((sum,column)=>sum+column.width,0);
  const actionWidth=columns[actionIndex]?.width??0;
  const link=activityFileLink(record);
  const displayed=fit(toolRow(record).action.map(segment=>segment.text).join(''),Math.max(1,actionWidth-1),false);
  const match=link?.label?displayed.indexOf(link.label):-1;
  // Only the filename span is a link, not the entire ACTION column.
  const fileStart=match>=0?start+cellWidth(displayed.slice(0,match)):-1;
  const overFile=match>=0&&event.x>=fileStart&&event.x<fileStart+cellWidth(link!.label);
  if(event.kind==='move'){
   setHoverLinkId(prev=>{
    const next=overFile?record.id:null;
    return prev===next?prev:next;
   });return;
  }
  if(event.kind!=='press'||event.button!==0||edit||confirm)return;
  if(event.ctrl&&overFile&&link){
   void openActivityFile(link).then(setNotice).catch(error=>setNotice(String(error)));
   return;
  }
  setFocus('activity');setSelectedId(record.id);setDetailTask(false);resetDetail();
 };
 const stop=async(ids:string[])=>{
  setConfirm(null);
  if(demo){
   setDemoStatus(prev=>prev?{...prev,active:prev.active.filter(t=>!ids.includes(t.id)),
    activity:prev.activity.map(a=>ids.includes(a.id)?{...a,status:'cancelled',finished_at:tick,duration_ms:tick-a.time}:a)}:prev);
   setNotice('DEMO · 已模拟停止 '+ids.length+' 个任务');return;
  }
  const results=await Promise.allSettled(ids.map(taskId=>requestLocal({action:'stop',taskId})));
  const stopped=results.filter(r=>r.status==='fulfilled'&&r.value?.stopped===true).length;
  setNotice('已发送停止信号 '+stopped+'/'+ids.length+(stopped<ids.length?' · 其余任务已结束或停止失败':''));
 };
 const executeSlash=(raw:string):boolean=>{
  const parsed=parseCommand(raw);
  if('error' in parsed){setNotice(parsed.error);return false;}
  const {id,args,value}=parsed;
  if(id==='help'){setNotice('命令：/config · /tasks · /latest · /stop · /view · /copy · /quit');return true;}
  if(id==='quit'){if(!demo){logEvent('tui','exit.requested','info',{reason:'slash_quit'});onIntentionalExit?.('slash_quit');}exit();return true;}
  if(id==='tasks'){
   if(tasks.length){setFocus('tasks');setDetailTask(true);resetDetail();}
   else setNotice('当前没有后台任务');
   return true;
  }
  if(id==='latest'){setSelectedId(null);setFocus('activity');setDetailTask(false);resetDetail();return true;}
  if(id==='stop'){
   const ids=args[0]==='all'?[...new Set((status?.active??[]).map(t=>t.id))]:
    (()=>{
     const current=focus==='tasks'?task?.id:entry?.id;
     return current&&(status?.active??[]).some(t=>t.id===current)?[current]:[];
    })();
   if(ids.length)setConfirm(ids);else setNotice('没有可停止的运行中进程');
   return true;
  }
  if(id==='view'){
   if(!entry){setNotice('请先选择活动记录');return true;}
   const mode=args[0]==='output'?
     ['exec_foreground','exec_background'].includes(entry.tool)?'stdout':'result':
     args[0]==='stderr'?'stderr':args[0]==='input'?'input':'summary';
   if(mode==='stderr'&&!['exec_foreground','exec_background'].includes(entry.tool)){
    setNotice('此工具没有 stderr，请使用 /view output');return true;
   }
   setInspectorTab(mode);setFocus('detail');setDetailScroll(0);
   if(selected&&selectedId===null)setSelectedId(selected.id);
   return true;
  }
  if(id==='copy'){
   const content=inspectorCopyText(inspectorTab,entry,inspectorSource,model?.command||model?.target||'');
   if(!content){setNotice('当前视图没有可复制内容');return true;}
   if(demo){setNotice('DEMO · 复制 '+content.length+' 字符');return true;}
   void copyText(content).then(()=>setNotice('已复制 '+content.length+' 字符'))
    .catch(error=>setNotice('复制失败：'+String(error)));
   return true;
  }
  if(id==='config'){
   const key=args[0]!;
   if(!value){
    if(demo){setNotice(key+' = '+(key==='name'?status?.deviceName:status?.server));return true;}
    void requestLocal({action:'config-get'},3000).then(c=>{
     setSettings(c);
     setNotice(key+' = '+String(key==='proxy-auto'?String(c.proxyAuto===true):key==='proxy-url'?(c.proxyUrl?'已配置':'null'):c[key]??'未配置')+(key==='url'&&c.pending?' · 待重新授权后切换':''));
    }).catch(error=>setNotice('配置读取失败：'+String(error)));
    return true;
   }
   if(demo){
    setSettings(prev=>({...prev,[key]:value}));
    setDemoStatus(prev=>prev?{...prev,...(key==='name'?{deviceName:value}:{server:value})}:prev);
    setNotice('DEMO · 已设置 '+key+' = '+value);return true;
   }
   void requestLocal({action:'config-set',key,value},18000).then(c=>{
    setSettings(prev=>({...prev,...c}));
    if(key==='name')setNotice('设备名称已同步：'+c.name);
    else if(key==='proxy-auto')setNotice('自动代理：'+String(c.proxyAuto===true));
    else if(key==='proxy-url')setNotice('手动代理：'+(c.proxyUrl?'已配置':'null'));
    else setNotice(c.pending?'新 URL 已暂存，当前连接不变；运行 deskbeacon setup --url '+c.url+' 重新授权后切换':
      'URL 未改变：'+c.url);
   }).catch(error=>setNotice('设置 '+key+' 失败：'+String(error)));
   return true;
  }
  return false;
 };
 useInput((input,key)=>{
  if(key.ctrl&&input==='c'){
   if(Date.now()-exitArmedAt<2500){if(!demo){logEvent('tui','exit.requested','info',{reason:'double_ctrl_c'});onIntentionalExit?.('double_ctrl_c');}exit();return;}
   setExitArmedAt(Date.now());setNotice('再次按 Ctrl+C 退出 · 2 秒内有效');return;
  }
  if(edit){
   if(key.escape){setEdit(null);setText('');setCommandIndex(0);return;}
   if(edit==='command'){
    if(key.upArrow||key.downArrow){
     const direction=key.upArrow?-1:1;
     setCommandIndex(i=>Math.max(0,Math.min(commandOptions.length-1,i+direction)));
     return;
    }
    if(key.tab||input===' '){
     const candidate=commandOptions[commandSelect];
     if(candidate?.selectable&&!text.endsWith(' ')&&candidate.insert.startsWith(text)){
      setText(candidate.insert);setCommandIndex(0);
     }else if(input===' '){setText(prev=>prev+' ');setCommandIndex(0);}
     return;
    }
    if(key.return){
     const candidate=commandOptions[commandSelect];
     const partial=commandMenu?.stage!=='value'&&candidate?.selectable&&
       candidate.insert.trim().startsWith(text.trim())&&candidate.insert.trim()!==text.trim();
     const next=partial?candidate.insert.trim():text.trim();
     if(executeSlash(next)){setEdit(null);setText('');setCommandIndex(0);}
     else if(partial){setText(candidate!.insert);setCommandIndex(0);}
     return;
    }
    if(key.backspace||key.delete){
     setText(prev=>prev.length>1?Array.from(prev).slice(0,-1).join(''):'/');setCommandIndex(0);return;
    }
    if(input&&!key.ctrl&&!key.meta){
     setText(prev=>stripMouseControlText(prev+oneLine(input)).slice(0,1024));setCommandIndex(0);
    }
    return;
   }
   if(key.return){const value=text.trim();setEdit(null);setText('');setQuery(value);
    setSelectedId(null);setDetailTask(false);setFocus('activity');resetDetail();return;}
   if(key.backspace||key.delete){setText(prev=>Array.from(prev).slice(0,-1).join(''));return;}
   if(input&&!key.ctrl&&!key.meta)setText(prev=>stripMouseControlText(prev+oneLine(input)).slice(0,256));
   return;
  }
  if(confirm){
   if(input==='y'||key.return){void stop(confirm);return;}
   if(input==='n'||key.escape)setConfirm(null);
   return;
  }
  if(input==='q'){if(!demo){logEvent('tui','exit.requested','info',{reason:'q'});onIntentionalExit?.('q');}exit();return;}
  if(key.escape){
   if(view!=='main'||inspectorTab!=='summary'){resetDetail();return;}
   if(query){setQuery('');setSelectedId(null);return;}
   setFocus('activity');setDetailTask(false);return;
  }
  if(demo&&/^[0-9]$/.test(input)){
   setDemoStatus(prev=>prev?advanceDemo(prev,input):prev);setNotice('DEMO · 场景 '+input);return;
  }
  if(input==='s'||input==='S'){setEdit('search');setText(query);setNotice('');return;}
  if(input==='/'){setEdit('command');setText('/');setCommandIndex(0);setNotice('');return;}
  if(input==='?'){setNotice(globalShortcuts(w));return;}
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
  if(input==='c'&&model){
   const content=inspectorCopyText(inspectorTab,entry,inspectorSource,model.command||model.target);
   if(!content){setNotice('当前视图没有可复制的内容');return;}
   if(demo){setNotice('DEMO · 复制 '+content.length+' 字符');return;}
   void copyText(content).then(()=>setNotice('已复制 '+content.length+' 字符')).catch(e=>setNotice(String(e)));return;
  }
  if((input==='i'||input==='o')&&entry){
   setInspectorTab(input==='i'?'input':
    ['exec_foreground','exec_background'].includes(entry.tool)?'stdout':'result');
   setFocus('detail');setDetailScroll(0);
   if(selected&&selectedId===null)setSelectedId(selected.id);return;
  }
  if(input==='e'&&(inspectorTab==='stdout'||inspectorTab==='stderr')){
   setInspectorTab(inspectorTab==='stdout'?'stderr':'stdout');return;
  }
  if(input==='r'&&inspectorTab!=='summary'){setRefresh(x=>x+1);return;}
 });
 const connected=ipcOfflineSince===null&&status?.state==='connected';
 const connecting=ipcOfflineSince===null&&(!status||status.state==='connecting');
 const connection=connected?'CONNECTED':connecting?'CONNECTING':'OFFLINE';
 const headerTheme=connected?barTheme.connected:connecting?barTheme.connecting:barTheme.disconnected;
 const host=(()=>{try{return new URL(status?.server??'').host;}catch{return status?.deviceName??'local runtime';}})();
 const taskStart=footerWindow.start;
 const activityPane=<Box flexDirection="column" width={aw} height={layout.activityHeight} overflow="hidden">
  <Title label={'ACTIVITY '+(demo?activities.length:pageTotal)} width={aw}
   right={(pageLoading?'加载中 · ':'')+(selectedId===null?'● LIVE':selectedIndex<0?'历史快照':(selectedIndex+1)+' / '+pageTotal)}
   rightColor={selectedId===null?stateColor.success:undefined} active={focus==='activity'}/>
  <Box height={1} paddingX={1} flexShrink={0}><Text color={palette.muted}>{'  '+columns.map(c=>(c.key==='elapsed'?rightFit(c.title,c.width-1):fit(c.title,c.width-1))+' ').join('')}</Text></Box>
  {visibleRows.length?visibleRows.map(row=>'kind' in row&&row.kind==='date'?
    <Line key={'day-'+row.timestamp} width={aw} text={' ┄ '+dailyLabel(row.timestamp)+' ┄'} color={palette.line}/>:<ActivityTableRow key={(row as ActivityEntry).id} record={row as ActivityEntry}
     columns={columns} isSelected={(row as ActivityEntry).id===selected?.id} timeAnchor={timeAnchor}
     linkHovered={hoverLinkId===(row as ActivityEntry).id}/>):<Line width={aw} text={pageError?' 历史读取失败 · '+pageError:pageLoading?' 正在加载活动…':activeQuery?' 没有匹配记录 · Esc 清除筛选':' 暂无操作，等待 Agent 请求'} color={palette.muted}/>}
 </Box>;
 const detailPane=<Box flexDirection="column" width={dw} height={layout.detailHeight} overflow="hidden">
  <Title label={view==='config'?'CONNECTION':inspectorTab==='input'?'INPUT':inspectorTab==='result'?'RESULT':inspectorTab!=='summary'?'OUTPUT':'DETAIL'} width={dw} active={focus==='detail'}
   right={detailScrollStatus(detail.length,detailRows,scroll)}/>
  {inspectorTab!=='summary'?<Box height={1} flexShrink={0} width={dw}>
   <Text color={inspectorTab==='input'?palette.accent:palette.muted}>{' [INPUT] '}</Text>
   {entry&&['exec_foreground','exec_background'].includes(entry.tool)?<>
    <Text color={inspectorTab==='stdout'?palette.accent:palette.muted}>{' [STDOUT] '}</Text>
    <Text color={inspectorTab==='stderr'?palette.accent:palette.muted}>{' [STDERR]'}</Text>
   </>:<Text color={inspectorTab==='result'?palette.accent:palette.muted}>{' [RESULT]'}</Text>}
  </Box>:null}
  <Box flexDirection="column" height={detailRows} overflow="hidden">
   {detail.slice(scroll,scroll+detailRows).map((item,i)=>
    entry?.status==='running'&&item.label==='DUR'
     ?<RunningDurationDetailCell key={entry.id+'-dur'} entry={entry} item={item} width={dw}/>
     :<DetailCell key={scroll+i} item={item} width={dw}/>)}
  </Box>
  <Line width={dw} text={inspectorTab!=='summary'?' i 输入 · o 输出 · c 复制 · e 流 · Esc':' i 输入 · o 输出 · c 复制 · ↑↓ 滚动'} color={palette.muted}/>
 </Box>;
 const ramTotalBytes=status?.totalMemoryBytes??0;
 const ramUsedBytes=Math.max(0,ramTotalBytes-(status?.availableMemoryBytes??0));
 const ramText=ramTotalBytes>0?(ramUsedBytes/1073741824).toFixed(1)+'/'+
  (ramTotalBytes/1073741824).toFixed(1)+'GB':'—/—GB';
 if(status&&(!uptimeAnchorRef.current||uptimeAnchorRef.current.device!==status.deviceId||status.uptimeMs<uptimeAnchorRef.current.uptime-2000))
  uptimeAnchorRef.current={device:status.deviceId,uptime:status.uptimeMs,at:Date.now()};
 const anchor=uptimeAnchorRef.current;
 const uptimeMs=demo?(status?.uptimeMs??0)+Math.max(0,tick-mountedAt):(anchor?.uptime??0)+Math.max(0,tick-(anchor?.at??tick));
 const runMode=demo?'DEMO':status?.runtimeMode==='service'?'SERVICE':status?.runtimeMode==='background'?'SERVICE':'FOREGROUND';
 const metrics=runMode+' · CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+ramText+' · '+(status?.operationsTotal??0)+' OPS · UP '+duration(uptimeMs);
 const compactHeader=w<56;
 const visibleTitle=safeText(terminalTitle,44).trim()||'DeskBeacon';
 const headerBrand=compactHeader?' '+visibleTitle:' ((·)) '+visibleTitle+(demo&&w>=65?' · DEMO':'');
 const headerLeftWidth=Math.min(w,Math.max(compactHeader?12:26,Math.min(48,cellWidth(headerBrand)+1)));
 const headerRightWidth=Math.max(0,w-headerLeftWidth);
 const footerPrompt=confirm?
  '停止 '+confirm.length+' 个进程及其子进程？ y / Enter 确认 · n / Esc 返回':
  notice||(ipcOfflineSince!==null?
   '本地 IPC 断开 · '+(ipcDisconnectReason||'连接已关闭')+' · '+duration(tick-ipcOfflineSince)+' · 正在重试；service status / logs':
   pageError?'活动读取失败 · '+pageError:globalShortcuts(w));
 const compactMetrics=w<40?'CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+ramText:
  w<72?'CPU '+(status?.cpuPercent??0).toFixed(1)+'% · RAM '+ramText+' · '+(status?.operationsTotal??0)+' OPS':metrics;
 const footerRightWidth=wideFooter?Math.min(64,Math.max(48,Math.floor(w*.48))):0;
 const footerLeftWidth=wideFooter?w-footerRightWidth:w;
 if(w<24||h<12)return <Box width={w} height={h} flexDirection="column" overflow="hidden">
  <Line text="((·)) DeskBeacon" width={w}/><Line text="终端过小，请放大到 24×12" width={w}/><Line text="q 退出" width={w}/>
 </Box>;
 return <Box flexDirection="column" width={w} height={h} overflow="hidden">
  <Box height={1} flexShrink={0} width={w} backgroundColor={headerTheme.background} justifyContent="space-between">
   <Text bold color={headerTheme.foreground}>{fit(headerBrand,headerLeftWidth)}</Text>
   <Text color={headerTheme.foreground}>{rightFit('● '+connection+' · '+(status?.latencyMs??'—')+' MS · '+host,Math.max(0,headerRightWidth-1))+' '}</Text>
  </Box>
  <Box height={3} flexShrink={0} borderStyle="single" borderColor={edit?palette.accent:palette.line} paddingX={1}>
   <Text color={edit?palette.accent:palette.muted}>{fit(edit?(edit==='search'?'⌕ '+text:'⌘ '+text)+'▏':
    query?'⌕ '+query+' · '+activities.length+' 条匹配 · Esc 清除':'⌕ 搜索：Agent、工具、描述、路径、命令、结果、状态 · 点击输入',Math.max(1,w-4))}</Text>
  </Box>
  {edit==='command'?<Box width={w} height={commandPanelHeight} flexShrink={0}
   flexDirection="column" overflow="hidden">
   <Line width={w} text={' COMMANDS · '+(commandMenu?.stage==='command'?'命令':commandMenu?.stage==='argument'?'参数':'配置值')} color={palette.accent}/>
   {commandOptions.slice(Math.max(0,commandSelect-visibleOptions+1),
       Math.max(0,commandSelect-visibleOptions+1)+paletteCount).map((option,index)=>{
    const first=Math.max(0,commandSelect-visibleOptions+1);
    return <CommandCandidateRow key={option.label+index} option={option} width={w}
      active={first+index===commandSelect&&option.selectable}/>;
   })}
   {commandOptions.length===0?<Line width={w} text="  无匹配候选，继续输入或按 Esc 返回" color={palette.muted}/>:null}
   <Line width={w} text={' '+(commandMenu?.hint??'')} color={palette.muted}/>
  </Box>:null}
  <Box width={w} height={bodyHeight} flexShrink={0} flexDirection={horizontal?'row':'column'} overflow="hidden">
   {activityPane}
   {horizontal?<Box width={1} height={bodyHeight}><Text color={palette.line}>{Array.from({length:bodyHeight},(_,i)=>i===0?'┯':detail[scroll+i-(inspectorTab==='summary'?1:2)]?.section?'├':'│').join('\n')}</Text></Box>:
    <Line text={'─'.repeat(w)} width={w} color={palette.line}/>}
   {detailPane}
  </Box>
  <BackgroundTable tasks={tasks} start={taskStart} slots={taskSlots} hidden={footerWindow.hidden}
   logs={backgroundLogs} width={w} height={taskHeight} focus={focus==='tasks'} selectedId={detailTask?task?.id??null:null}
   horizontal={horizontal} activityWidth={aw}/>
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

export async function showTui(demoScenario?:DemoScenario,terminalTitle='DeskBeacon',onIntentionalExit?:(reason:string)=>void){
 const bridge=new TuiInputBridge(process.stdin);
 const guard=installTuiTerminalGuard();
 const startedAt=Date.now();
 let exitReason:string|null=null;
 const onExit=(reason:string)=>{exitReason=reason;onIntentionalExit?.(reason);};
 logEvent('tui','session.started','info',{pid:process.pid,terminal:process.env.TERM_PROGRAM??'unknown',isTTY:process.stdout.isTTY===true});
 try{
  guard.enter();
  const app=render(<App {...(demoScenario?{demoScenario}:{})} mouseEvents={bridge.mouse} terminalTitle={terminalTitle} onIntentionalExit={onExit}/>,{
   stdin:bridge.keyboard as unknown as typeof process.stdin,
   interactive:process.stdout.isTTY===true,exitOnCtrlC:false});
  await app.waitUntilExit();
  logEvent('tui','session.exited',exitReason?'info':'warn',{reason:exitReason??'unknown',durationMs:Date.now()-startedAt});
 }catch(error){logEvent('tui','session.failed','error',{error,durationMs:Date.now()-startedAt});throw error;}
 finally{
  // Turn off reporting before removing the input handler, or late SGR mouse packets
  // leak into the PowerShell prompt while the terminal is still processing teardown.
  try{await guard.restore();}
  finally{guard.dispose();bridge.dispose();}
  writeTerminalTitle('DeskBeacon');
  await flushLogs();
 }
}
