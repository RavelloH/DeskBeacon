import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { freemem as freeMemory, totalmem as totalMemory } from 'node:os';
import { requestIpc } from './ipc.js';
type Activity={id:string;tool:string;description:string;status:string;grant_id:string;time:number};
type Running={id:string;description:string;pid:number;start:number;kind:'foreground'|'background'};
type Transfer={id:string;status:string;bytes:number;path:string};
type Status={state:string;deviceName:string;deviceId:string;server:string;activity:Activity[];active:Running[];transfers?:Transfer[]};
type Details={activity?:Record<string,unknown>;outputs?:Array<{filename:string;text:string}>};
const sanitize=(s:string)=>s.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'').replace(/[\x00-\x08\x0B-\x1F\x7F]/g,'');
const preview=(s:string)=>sanitize(s).split('\n').slice(-18).join('\n').slice(-8000);
function App(){
 const [status,setStatus]=useState<Status|null>(null);
 const [search,setSearch]=useState('');
 const [notice,setNotice]=useState('');
 const [focus,setFocus]=useState<'activity'|'tasks'>('activity');
 const [selected,setSelected]=useState(0);
 const [selectedTask,setSelectedTask]=useState(0);
 const [expanded,setExpanded]=useState<Record<string,boolean>>({});
 const [details,setDetails]=useState<Record<string,Details>>({});
 const {exit}=useApp();
 useEffect(()=>{
   let active=true;
   const refresh=()=>{void requestIpc({action:'status'}).then(x=>{if(active)setStatus(x as Status);}).catch(e=>{if(active)setNotice(String(e));});};
   refresh();const timer=setInterval(refresh,900);
   return()=>{active=false;clearInterval(timer);};
 },[]);
 const entries=(status?.activity??[]).filter(a=>!search||search.startsWith('/')||(a.description+' '+a.tool+' '+a.grant_id).toLowerCase().includes(search.toLowerCase())).slice(0,60);
 const background=(status?.active??[]).filter(t=>t.kind==='background');
 const transfers=(status?.transfers??[]).filter(t=>t.status!=='completed'&&t.status!=='failed');
 const longTasks=[...background.map(x=>({...x,id:x.id,title:x.description,kind:'background'})),
                   ...transfers.map(x=>({...x,id:x.id,title:x.path,kind:'transfer'}))];
 const loadDetails=(id:string)=>{void requestIpc({action:'logs',operationId:id}).then(x=>setDetails(old=>({...old,[id]:x as Details}))).catch(e=>setNotice(String(e)));};
 const stop=(id:string)=>{void requestIpc({action:'stop',taskId:id}).then(()=>setNotice('Stopped '+id.slice(0,8))).catch(e=>setNotice(String(e)));};
 useInput((input,key)=>{
   if(key.escape){setSearch('');return;}
   if(key.tab){setFocus(f=>f==='activity'?'tasks':'activity');return;}
   if(key.upArrow){
     if(focus==='activity')setSelected(x=>Math.max(0,x-1));else setSelectedTask(x=>Math.max(0,x-1));
     return;
   }
   if(key.downArrow){
     if(focus==='activity')setSelected(x=>Math.min(Math.max(entries.length-1,0),x+1));
     else setSelectedTask(x=>Math.min(Math.max(longTasks.length-1,0),x+1));
     return;
   }
   if(key.return){
     if(search.startsWith('/stop ')){stop(search.slice(6).trim());setSearch('');return;}
     if(search==='/quit'||search==='/exit'){exit();return;}
     if(search==='/help'){setNotice('Commands: /stop <id>, /quit; Tab switch, arrows select, Enter expand, x stop');setSearch('');return;}
     if(focus==='activity'){
       const a=entries[selected];
       if(a){setExpanded(old=>({...old,[a.id]:!old[a.id]}));loadDetails(a.id);}
     }else{
       const t=longTasks[selectedTask];if(t)stop(t.id);
     }
     return;
   }
   if(key.backspace||key.delete){setSearch(s=>s.slice(0,-1));return;}
   if(input==='q'&&!search){exit();return;}
   if(input==='x'&&!search){
     const id=focus==='tasks'?longTasks[selectedTask]?.id:entries[selected]?.id;
     if(id&&(status?.active??[]).some(t=>t.id===id))stop(id);
     return;
   }
   if(input&&!key.ctrl&&!key.meta)setSearch(s=>s+input);
 });
 const ram=(100*(1-freeMemory()/totalMemory())).toFixed(1);
 return <Box flexDirection="column" paddingX={1}>
   <Box borderStyle="round" paddingX={1} justifyContent="space-between">
     <Text color="cyan" bold>(( · )) DeskBeacon</Text>
     <Text color={status?.state==='connected'?'green':'yellow'}>{status?.state??'Starting'}</Text>
   </Box>
   <Box justifyContent="space-between"><Text dimColor>{status?.deviceName??'Local device'}</Text>
     <Text dimColor>Agents / local timeline</Text></Box>
   <Box borderStyle="single" paddingX={1}><Text color="cyan">/ </Text>
     <Text>{search||'Search operations or /stop ID'}</Text></Box>
   <Box justifyContent="space-between"><Text bold color={focus==='activity'?'cyan':'white'}>ACTIVITY</Text>
     <Text dimColor>Tab: switch · Enter: details</Text></Box>
   {entries.length===0?<Text dimColor>No matching recent operations</Text>:
    entries.map((a,index)=><Box key={a.id} flexDirection="column">
      <Text color={index===selected&&focus==='activity'?'cyan':'white'}>
        {index===selected&&focus==='activity'?'› ':'  '}{a.status==='completed'?'✓':a.status==='running'?'○':'!'} {a.description.slice(0,55)}
        <Text dimColor> [{a.tool}]</Text>
      </Text>
      {expanded[a.id]?<Box paddingLeft={3} flexDirection="column">
        <Text dimColor>{a.id} · {a.grant_id.slice(0,16)} · {new Date(a.time).toLocaleTimeString()}</Text>
        {details[a.id]?.activity?.request_json?<Text dimColor>
          {'Args: '+preview(String(details[a.id]!.activity!.request_json))}
        </Text>:null}
        {details[a.id]?.outputs?.map(o=><Box key={o.filename} flexDirection="column">
          <Text bold>{o.filename.endsWith('.err')?'stderr':'stdout'}:</Text>
          <Text>{preview(o.text)||'(empty)'}</Text>
        </Box>)}
      </Box>:null}
    </Box>)}
   <Box marginTop={1} borderStyle="single" paddingX={1} flexDirection="column">
     <Box justifyContent="space-between"><Text bold color={focus==='tasks'?'cyan':'white'}>LONG-RUNNING TASKS</Text>
       <Text dimColor>{longTasks.length} active</Text></Box>
     {longTasks.length===0?<Text dimColor>No background tasks or transfers</Text>:
       longTasks.map((t,index)=><Text key={t.id} color={focus==='tasks'&&index===selectedTask?'cyan':'green'}>
         {focus==='tasks'&&index===selectedTask?'› ':'  '}{t.kind==='background'?'▶':'↕'} {t.title.slice(0,38)}
         {' '}ID {t.id.slice(0,8)}{t.kind==='background'?' · '+Math.floor((Date.now()-(t as Running).start)/1000)+'s':''}
       </Text>)}
   </Box>
   <Box justifyContent="space-between">
     <Text dimColor>RAM {ram}% | {notice?notice.slice(0,54):'Local supervisor ready'}</Text>
     <Text dimColor>↑↓ · Tab · Enter · x stop · q quit</Text>
   </Box>
 </Box>;
}
export function showTui(){render(<App/>);}
