import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {desktopExecutable} from './executable.js';
import {desktopPolicy,requireDesktopPermission} from './policy.js';
import {DesktopRefOwnership} from './ref-ownership.js';
import {compareDesktopText} from './text-verification.js';

type Input=Record<string,any>;
// Explicit native sessions are owned by one OAuth grant and are never global MCP capabilities.
const ownedSessions=new Map<string,string>();
const refOwnership=new DesktopRefOwnership();
let sharedCursorSession:string|null=null;
let cursorStarting:Promise<string>|null=null;

/** Shared *visual* Session only. UI actions remain scoped to each OAuth grant's agent-id. */
async function sharedCursor():Promise<string>{
 if(sharedCursorSession)return sharedCursorSession;
 if(!cursorStarting)cursorStarting=(async()=>{
  const created=await runNative('session',['start','--no-trace','--cursor','--multi-agent',
    '--name','DeskBeacon shared cursors'],15000);
  const id=created.data?.session_id;
  if(typeof id!=='string'||!id)throw nativeError('DESKTOP_RESULT_INVALID','Shared cursor session did not return an ID');
  sharedCursorSession=id;
  return id;
 })().finally(()=>{cursorStarting=null;});
 return cursorStarting;
}
export async function stopSharedCursor():Promise<void>{
 if(cursorStarting)await cursorStarting.catch(()=>{});
 const session=sharedCursorSession;
 sharedCursorSession=null;
 if(session){refOwnership.clearSession(session);await runNative('session',['end',session],10000).catch(()=>{});}
}
/** The native manifests are auxiliary runtime state, never the source of operation history. */
export async function disposeDesktopSessions():Promise<void>{
 await stopSharedCursor();
 const sessions=[...ownedSessions.keys()];
 ownedSessions.clear();
 refOwnership.clear();
 await Promise.allSettled(sessions.map(id=>runNative('session',['end',id],10000)));
}

// Native snapshots are private to the OAuth grant, not to the desktop as a whole.
export function namespace(grantId:string):string{
  return 'db-'+createHash('sha256').update(grantId).digest('hex').slice(0,24);
}

function flag(args:string[],name:string,value:unknown):void{
  if(value!==undefined&&value!==null)args.push(name,String(value));
}
function enabled(args:string[],name:string,value:unknown):void{
  if(value===true)args.push(name);
}

function nativeError(code:string,message:string,partialResult?:unknown):Error{
  const err=Object.assign(new Error(code+': '+message.slice(0,1200)),{code,
    ...(partialResult===undefined?{}:{partialResult})});
  return err;
}

/** Invoke the package's exact native binary, without shell interpretation or command interpolation. */
export async function runNative(command:string,args:string[],timeoutMs=15000,maxBytes=160*1024,signal?:AbortSignal):Promise<Record<string,any>>{
  if(signal?.aborted)throw nativeError('DESKTOP_CANCELLED','Operation cancelled before delivery',{disposition:{delivery:'not_delivered',retry:'safe'}});
  const executable=await desktopExecutable();
  if(signal?.aborted)throw nativeError('DESKTOP_CANCELLED','Operation cancelled before delivery',{disposition:{delivery:'not_delivered',retry:'safe'}});
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[command,...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],signal});
    let stdout='',stderr='',bytes=0,settled=false,timedOut=false;
    const finish=(error?:Error,result?:Record<string,any>)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve(result!);
    };
    const timer=setTimeout(()=>{
      timedOut=true;child.kill();
    },timeoutMs);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const accumulate=(target:'stdout'|'stderr',chunk:string)=>{
      bytes+=Buffer.byteLength(chunk);
      if(bytes>maxBytes){child.kill();finish(nativeError('DESKTOP_OUTPUT_LIMIT','Native output exceeded response limit'));return;}
      if(target==='stdout')stdout+=chunk;else stderr+=chunk;
    };
    child.stdout.on('data',(chunk:string)=>accumulate('stdout',chunk));
    child.stderr.on('data',(chunk:string)=>accumulate('stderr',chunk));
    child.on('error',(error)=>finish(signal?.aborted?
      nativeError('DESKTOP_CANCELLED','Desktop subprocess cancelled; delivery may be unknown',
        {disposition:{delivery:'delivered_unverified',retry:'unsafe'}}):
      nativeError('DESKTOP_EXECUTION_FAILED',error.message)));
    child.on('close',(exitCode)=>{
      if(settled)return;
      if(timedOut)return finish(nativeError('DESKTOP_TIMEOUT','Native command exceeded deadline; action delivery may be unknown'));
      let envelope:Record<string,any>;
      try{envelope=JSON.parse(stdout.trim());}
      catch{return finish(nativeError('DESKTOP_RESULT_INVALID','Invalid JSON envelope from native CLI (exit '+exitCode+')')); }
      if(envelope.ok!==true || exitCode!==0){
        const detail=envelope.error??{};
        return finish(nativeError(
          /^[A-Z][A-Z0-9_]{2,63}$/.test(String(detail.code??''))?detail.code:'DESKTOP_ACTION_FAILED',
          String(detail.message??'agent-desktop failed'),
          {disposition:detail.disposition,details:detail.details,suggestion:detail.suggestion}));
      }
      return finish(undefined,envelope);
    });
  });
}


type WindowInfo={id:string;app_name:string;title?:string;is_focused?:boolean;accessible?:boolean;bounds?:{x:number;y:number;width:number;height:number};process_instance?:string;pid?:number};
function windowsFrom(result:Record<string,any>):WindowInfo[]{
 const data=result.data;
 return (Array.isArray(data)?data:Array.isArray(data?.windows)?data.windows:[]) as WindowInfo[];
}
function canonicalApp(name:string):string{
 return name.toLowerCase().replace(/\\/g,'/').split('/').pop()!.replace(/\.exe$/,'');
}
export function matchesApp(requested:string,observed:string):boolean{
 const a=canonicalApp(requested),b=canonicalApp(observed);
 if(a===b)return true;
 // The Windows Calculator launch alias is "calc", but its accessible process is CalculatorApp.exe.
 return process.platform==='win32'&&
   ((a==='calc'||a==='calculator')&&b==='calculatorapp');
}
async function nativeWindows(signal?:AbortSignal):Promise<WindowInfo[]>{
 const result=await runNative('list-windows',[],10000,160*1024,signal);
 return windowsFrom(result);
}
function selectedWindow(rows:WindowInfo[],input:Input):WindowInfo|undefined{
 return rows.find(row=>input.windowId?row.id===input.windowId:
   typeof input.app==='string'&&matchesApp(input.app,row.app_name));
}
function nativePostState(command:string,data:Record<string,unknown>):Record<string,unknown>{
 return {ok:true,command,data};
}
/** The native launcher can outlive its caller after creating a GUI process. Only newly observed,
 * identity-matching GUI windows provide enough evidence to report a verified launch.
 * Preexisting matching windows must not be reported as new launches. */
async function launchWithPostcondition(input:Input,args:string[],signal?:AbortSignal):Promise<Record<string,any>>{
 const nativeDeadline=Math.min(input.timeoutMs??15000,120000);
 let before:WindowInfo[]|null=null;
 try{before=await nativeWindows(signal);}catch{/* Preserve upstream result if window discovery is unavailable. */}
 const start=Date.now();
 try{
  const launched=await runNative('launch',[...args,'--timeout',String(nativeDeadline)],nativeDeadline+3500,160*1024,signal);
  // Process running is not the same as a focused GUI window.
  let after:WindowInfo[]|null=null;
  try{after=await nativeWindows(signal);}catch{}
  const matched=after?.filter(row=>matchesApp(input.app,row.app_name))??[];
  const focused=matched.some(row=>row.is_focused===true);
  return {...launched,data:{...launched.data,launchState:{
   processRunning:true,windowDetected:after===null?null:matched.length>0,
   foregroundVerified:after===null?null:focused,
   activationRequested:input.activate===true}}};
 }catch(error){
  const err=error as Error & {code?:string};
  if(signal?.aborted||before===null||!['DESKTOP_TIMEOUT','TIMEOUT','WINDOW_NOT_FOUND','ACTION_FAILED'].includes(err.code??''))throw error;
  let after:WindowInfo[];
  try{after=await nativeWindows(signal);}catch{throw error;}
  const beforeIds=new Set(before.map(w=>w.process_instance??w.id));
  const created=after.find(row=>matchesApp(input.app,row.app_name)&&
    !beforeIds.has(row.process_instance??row.id) && (!input.activate||row.is_focused));
  if(!created)throw error;
  return nativePostState('launch',{
   app:input.app,window:created,elapsed_ms:Date.now()-start,
   disposition:{delivery:'delivered_verified',retry:'unsafe'},
   details:{verification_scope:'new_application_window',upstream_error:err.code,launch_result:'observed_after_native_timeout'}
  });
 }
}

function actionUndelivered(error:unknown):boolean{
 const e=error as {partialResult?:{disposition?:{delivery?:string};details?:{physical_delivery_started?:boolean}}};
 return e.partialResult?.disposition?.delivery==='not_delivered'&&
   e.partialResult?.details?.physical_delivery_started!==true;
}
function sessionFlags(args:string[],input:Input):string[]{
 const idx=args.findIndex(v=>v===input.refId||v==='--window-id'||v==='--app');
 return idx<0?args.slice():args.slice(0,idx);
}
function focusableRef(tree:any):string|undefined{
 let found:string|undefined;
 function visit(node:any):void{
  if(found||!node||typeof node!=='object')return;
  const actions=Array.isArray(node.available_actions)?node.available_actions:[];
  if(node.ref_id&&actions.includes('SetFocus')&&
    ['textfield','listbox','tab','button','menuitem'].includes(String(node.role)) &&
    !/^(关闭|close)(\s|$)/i.test(String(node.name??''))){found=node.ref_id;return;}
  for(const child of node.children??[])visit(child);
 }
 visit(tree);
 return found;
}
/** Only when native foreground delivery never started, retry by focusing a harmless,
 * accessibility-backed control and verifying the exact target window became focused. */
async function focusByAccessibility(window:WindowInfo,args:string[],input:Input,signal?:AbortSignal):Promise<boolean>{
 if(!window.accessible&&'accessible' in window)return false;
 const prefix=sessionFlags(args,input);
 const snapshot=await runNative('snapshot',[...prefix,'--window-id',window.id,'-i','--compact','--max-depth','10'],
   12000,160*1024,signal);
 const ref=focusableRef(snapshot.data?.tree);
 if(!ref)return false;
 await runNative('focus',[...prefix,ref],12000,160*1024,signal);
 return selectedWindow(await nativeWindows(signal),{windowId:window.id})?.is_focused===true;
}
async function hoverWithRecovery(input:Input,args:string[],signal?:AbortSignal):Promise<Record<string,any>>{
 const limit=Math.min(input.timeoutMs??15000,120000)+2500;
 try{return await runNative('hover',args,limit,160*1024,signal);}
 catch(error){
  if(!input.refId||!actionUndelivered(error)||signal?.aborted)throw error;
  const prefix=sessionFlags(args,input),ref=input.refId;
  // Ref focus uses accessibility only; no mouse event has yet been delivered.
  try{await runNative('focus',[...prefix,ref],12000,160*1024,signal);}
  catch(focusError){
   if(!actionUndelivered(focusError))throw focusError;
   throw nativeError('DESKTOP_FOREGROUND_UNAVAILABLE',
    'Windows denied focusing the hover target; physical pointer delivery did not begin',
    {disposition:{delivery:'not_delivered',retry:'safe'},
     suggestion:'Focus the target window manually, then retry the ref hover; avoid blind coordinate input.'});
  }
  try{return await runNative('hover',args,limit,160*1024,signal);}
  catch(second){
   if(!actionUndelivered(second)||signal?.aborted)throw second;
   const boundsResult=await runNative('get',[...prefix,ref,'--property','bounds'],10000,160*1024,signal);
   const rect=boundsResult.data?.value;
   if(!rect||!Number.isFinite(rect.x)||!Number.isFinite(rect.y)||
      !Number.isFinite(rect.width)||!Number.isFinite(rect.height)||
      rect.width<=0||rect.height<=0)throw second;
   const point={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
   const rows=await nativeWindows(signal);
   // The physical fallback is valid only when exactly one foreground window covers the target.
   const foreground=rows.filter(w=>w.is_focused===true&&w.bounds&&
     point.x>=w.bounds.x&&point.x<=w.bounds.x+w.bounds.width&&
     point.y>=w.bounds.y&&point.y<=w.bounds.y+w.bounds.height);
   if(foreground.length!==1)throw second;
   const moved=await runNative('mouse-move',[...prefix,'--xy',point.x+','+point.y],
     limit,160*1024,signal);
   return nativePostState('hover',{action:'hover',target:{ref,point,window_id:foreground[0]!.id},
     disposition:{delivery:moved.data?.disposition?.delivery??'delivered_unverified',retry:'unsafe'},
     details:{recovery:'focused_ref_then_coordinate_move',verified:false}});
  }
 }
}

async function focusWindowWithPostcondition(input:Input,args:string[],signal?:AbortSignal):Promise<Record<string,any>>{
 const initial=selectedWindow(await nativeWindows(signal),input);
 if(initial?.is_focused){
  return nativePostState('focus-window',{window:initial,
   disposition:{delivery:'delivered_verified',retry:'safe'},
   details:{already_focused:true,verification_scope:'window_focus'}});
 }
 try{return await runNative('focus-window',args,Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);}
 catch(error){
  if(signal?.aborted)throw error;
  let after=selectedWindow(await nativeWindows(signal),input);
  if(!after?.is_focused&&after?.accessible&&actionUndelivered(error)&&input.interactionMode==='headed'){
   try{await focusByAccessibility(after,args,input,signal);}catch{/* Keep original native error if verified focus cannot be established. */}
   after=selectedWindow(await nativeWindows(signal),input);
  }
  if(!after?.is_focused){
   if(actionUndelivered(error)&&process.platform==='win32')
    throw nativeError('DESKTOP_FOREGROUND_UNAVAILABLE',
      'Windows did not allow the requested application to become foreground; no physical input was delivered',
      {disposition:{delivery:'not_delivered',retry:'safe'},details:{window_id:input.windowId??after?.id,upstream_error:(error as {code?:string}).code},
       suggestion:'Bring the window to the foreground manually, then retry or use headless accessibility actions.'});
   throw error;
  }
  return nativePostState('focus-window',{window:after,
   disposition:{delivery:'delivered_verified',retry:'unsafe'},
   details:{verification_scope:'window_focus',upstream_error:(error as {code?:string}).code,
    recovery:'accessibility_focus_and_state_verification'}});
 }
}
export function closeButton(tree:any):string|undefined{
 const matches:string[]=[];
 function visit(node:any,withinTitlebar=false):void{
  if(!node||typeof node!=='object')return;
  const inTitle=withinTitlebar||String(node.native_id?.value??'').toLowerCase()==='titlebar'||
   String(node.name??'').toLowerCase()==='标题栏';
  const name=String(node.name??'');
  if(node.role==='button'&&typeof node.ref_id==='string'&&(
    String(node.native_id?.value??'').toLowerCase()==='close'||
    (inTitle&&/^(关闭|close)(\s|$)/i.test(name))))matches.push(node.ref_id);
  for(const child of node.children??[])visit(child,inTitle);
 }
 visit(tree);
 return matches.length===1?matches[0]:undefined;
}
/** Graceful fallback for packaged Windows apps whose windows appear in list-windows but
 * whose process identity cannot be resolved by close-app. Never terminate or force-close. */
async function closePackagedWindow(input:Input,args:string[],signal?:AbortSignal):Promise<Record<string,any>>{
 const windows=(await nativeWindows(signal)).filter(w=>matchesApp(input.app,w.app_name));
 if(windows.length===0)throw nativeError('APP_NOT_FOUND','No accessible window belongs to '+input.app);
 if(windows.length!==1)throw nativeError('AMBIGUOUS_TARGET',
  'Cannot safely resolve a single target window for packaged application '+input.app);
 const window=windows[0]!;
 const prefix=args.slice(0,args.lastIndexOf(input.app));
 const snapshot=await runNative('snapshot',[...prefix,'--window-id',window.id,'-i','--compact'],
   12000,160*1024,signal);
 const ref=closeButton(snapshot.data?.tree);
 if(!ref)throw nativeError('ACTION_NOT_SUPPORTED','Could not uniquely identify a title-bar Close control');
 const clicked=await runNative('click',[...prefix,ref],12000,160*1024,signal);
 let remaining=await nativeWindows(signal);
 for(let attempt=0;attempt<3&&remaining.some(w=>w.id===window.id);attempt++){
  await new Promise(resolve=>setTimeout(resolve,150));
  remaining=await nativeWindows(signal);
 }
 if(remaining.some(w=>w.id===window.id))
  throw nativeError('DESKTOP_CLOSE_UNVERIFIED','Close control was activated but the window remains visible',
   {disposition:{delivery:clicked.data?.disposition?.delivery??'delivered_unverified',retry:'unsafe'}});
 return nativePostState('close-app',{app:input.app,window_id:window.id,method:'window_close_control',
  disposition:{delivery:'delivered_verified',retry:'unsafe'},
  details:{verification_scope:'window_absent',native_app_discovery:'unavailable'}});
}

export async function executeDesktopTool(
  tool:string,input:Input,grantId:string,signal?:AbortSignal,
):Promise<Record<string,unknown>>{
  requireDesktopPermission(tool,input);
  const args:string[]=[];
  if(input.sessionId && ownedSessions.get(input.sessionId)!==grantId)
    throw nativeError('DESKTOP_SESSION_FORBIDDEN','Session is not owned by the current Agent');
  const policy=desktopPolicy();
  if(!policy.cursor&&sharedCursorSession)await stopSharedCursor();
  const visualId=policy.cursor&&tool!=='desktop_status'&&tool!=='desktop_session'&&!input.sessionId
    ?await sharedCursor():null;
  const sessionId=input.sessionId??visualId??namespace(grantId);
  // Native --agent-id is NOT an authorization boundary. Validate before any native call.
  refOwnership.assertInputs(input,grantId,sessionId);
  // Multi-agent visual sessions use an agent-specific refmap, not a shared ref namespace.
  if(tool!=='desktop_status'&&tool!=='desktop_session'){
    flag(args,'--session',sessionId);
    if(visualId||input.sessionId)
      flag(args,'--agent-id','agent-'+createHash('sha256').update(grantId).digest('hex').slice(0,24));
  }
  const intendedMode=input.interactionMode??'headless';
  if(intendedMode==='headed')enabled(args,'--headed',true);
  let command:string;
  switch(tool){
    case 'desktop_status':
      command='status';break;
    case 'desktop_list':
      command=({apps:'list-apps',windows:'list-windows',displays:'list-displays',surfaces:'list-surfaces'} as Record<string,string>)[input.kind]!;
      if(command!=='list-displays')flag(args,'--app',input.app);
      break;
    case 'desktop_snapshot':
      command='snapshot';flag(args,'--app',input.app);flag(args,'--window-id',input.windowId);
      flag(args,'--root',input.rootRef);flag(args,'--surface',input.surface);
      enabled(args,'-i',input.interactiveOnly!==false);
      enabled(args,'--compact',input.compact!==false);
      enabled(args,'--skeleton',input.skeleton);
      flag(args,'--max-depth',input.maxDepth??10);
      enabled(args,'--include-bounds',input.includeBounds);
      break;
    case 'desktop_find':
      command='find';flag(args,'--app',input.app);flag(args,'--window-id',input.windowId);
      flag(args,'--root',input.rootRef);flag(args,'--surface',input.surface);
      for(const key of ['role','name','text','value'] as const)flag(args,'--'+key,input[key]);
      enabled(args,'--exact',input.exact);flag(args,'--limit',input.limit??10);
      break;
    case 'desktop_get':
      command=['visible','enabled','checked','focused','expanded','selected'].includes(input.property)?'is':'get';
      args.push(input.refId);flag(args,'--property',input.property);break;
    case 'desktop_click':
      command=({single:'click',double:'double-click',triple:'triple-click',right:'right-click'} as Record<string,string>)[input.kind]!;
      if(input.kind!=='single'&&intendedMode!=='headed')
        throw nativeError('DESKTOP_POLICY_DENIED','Double/triple/right click requires interactionMode=headed on supported systems');
      args.push(input.refId);break;
    case 'desktop_input':
      if(input.action==='type'&&process.platform==='win32'&&intendedMode!=='headed')
        throw nativeError('DESKTOP_REQUIRES_HEADED','Windows text typing requires headed input');
      command=({set_value:'set-value',type:'type',clear:'clear'} as Record<string,string>)[input.action]!;
      args.push(input.refId);
      if(input.action!=='clear')args.push(input.text);
      if(input.action==='type')flag(args,'--interval-ms',input.intervalMs);
      break;
    case 'desktop_control':{
      command=({scroll_to:'scroll-to',...Object.fromEntries(
        ['select','check','uncheck','toggle','expand','collapse','focus','scroll'].map(name=>[name,name])
      )} as Record<string,string>)[input.action]!;
      args.push(input.refId);
      if(input.action==='select')args.push(input.value);
      if(input.action==='scroll'){flag(args,'--direction',input.direction??'down');flag(args,'--amount',input.amount??3);}
      break;
    }
    case 'desktop_press':
      if(intendedMode!=='headed')throw nativeError('DESKTOP_POLICY_DENIED','Keyboard shortcuts require headed input');
      command='press';args.push(input.key);flag(args,'--app',input.app);flag(args,'--window-id',input.windowId);
      break;
    case 'desktop_pointer':
      if(intendedMode!=='headed')throw nativeError('DESKTOP_POLICY_DENIED','Physical pointer movement requires headed input');
      command=({hover:'hover',move:'mouse-move',click:'mouse-click',drag:'drag',wheel:'mouse-wheel'} as Record<string,string>)[input.action]!;
      if(input.action==='hover'){
        if(input.refId)args.push(input.refId);
        else flag(args,'--xy',input.x+','+input.y);
      }else if(input.action==='move'||input.action==='click'){
        flag(args,'--xy',input.x+','+input.y);
        if(input.action==='click'){flag(args,'--button',input.button);flag(args,'--count',input.count);}
      }else if(input.action==='drag'){
        if(input.fromRef)flag(args,'--from',input.fromRef);
        else flag(args,'--from-xy',input.x+','+input.y);
        if(input.toRef)flag(args,'--to',input.toRef);
        else flag(args,'--to-xy',input.toX+','+input.toY);
        flag(args,'--duration',input.durationMs);
      }else{
        flag(args,'--x',input.x);flag(args,'--y',input.y);flag(args,'--dx',input.deltaX);
        flag(args,'--dy',input.deltaY);
      }
      break;
    case 'desktop_app':
      command=input.action==='launch'?'launch':'close-app';args.push(input.app);
      if(input.action==='launch'){
       enabled(args,'--activate',input.activate);
       for(const value of input.launchArgs??[])args.push('--arg='+value);
       flag(args,'--cwd',input.workingDirectory);
      }else enabled(args,'--force',input.force);
      break;
    case 'desktop_window':
      command=({focus:'focus-window',move:'move-window',resize:'resize-window',
        minimize:'minimize',maximize:'maximize',restore:'restore'} as Record<string,string>)[input.action]!;
      flag(args,'--app',input.app);flag(args,'--window-id',input.windowId);
      if(input.action==='move'){flag(args,'--x',input.x);flag(args,'--y',input.y);}
      if(input.action==='resize'){flag(args,'--width',input.width);flag(args,'--height',input.height);}
      break;
    case 'desktop_session':{
      if(input.action==='info')return {ok:true,command:'session',data:{session_id:input.sessionId,owner:'current-agent',
        explicit:true},desktop:{sessionId:input.sessionId,engine:'agent-desktop'}};
      if(input.action==='list')return {ok:true,command:'session',data:{sessions:[...ownedSessions]
        .filter(([,owner])=>owner===grantId).map(([id])=>({session_id:id}))},desktop:{engine:'agent-desktop'}};
      if(input.action==='start'){
        const startArgs=['start','--no-trace'];
        flag(startArgs,'--name',input.name??'DeskBeacon');
        const created=await runNative('session',startArgs,Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);
        const id=created.data?.session_id;
        if(typeof id!=='string'||!id)throw nativeError('DESKTOP_RESULT_INVALID','Session start returned no session_id');
        ownedSessions.set(id,grantId);
        return {...created,desktop:{sessionId:id,engine:'agent-desktop'}};
      }
      const id=input.sessionId;
      const finished=await runNative('session',['end',id],Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);
      ownedSessions.delete(id);
      refOwnership.clearSession(id);
      return {...finished,desktop:{sessionId:id,engine:'agent-desktop'}};
    }
    case 'desktop_wait':
      command='wait';
      switch(input.condition){
        case 'element':flag(args,'--element',input.refId);flag(args,'--predicate',input.predicate);flag(args,'--value',input.value);break;
        case 'window':flag(args,'--window',input.windowTitle);flag(args,'--app',input.app);break;
        case 'text':flag(args,'--text',input.text);flag(args,'--app',input.app);break;
        case 'menu_open':enabled(args,'--menu',true);flag(args,'--app',input.app);break;
        case 'menu_closed':enabled(args,'--menu-closed',true);flag(args,'--app',input.app);break;
        case 'event':flag(args,'--event',input.event);flag(args,'--app',input.app);break;
        case 'notification':enabled(args,'--notification',true);flag(args,'--app',input.app);break;
      }
      flag(args,'--timeout',Math.min(input.timeoutMs??15000,120000));
      break;
    default:throw nativeError('UNSUPPORTED_TOOL','Desktop action is not implemented: '+tool);
  }
  // Execution deadline includes initialization, ref resolution and native UI activity.
  let result:Record<string,any>;
  if(tool==='desktop_app'&&input.action==='launch'){
    result=await launchWithPostcondition(input,args,signal);
  }else if(tool==='desktop_input'&&input.action==='set_value'){
    try{result=await runNative(command,args,Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);}
    catch(error){
      const e=error as {code?:string;partialResult?:{disposition?:{delivery?:string};
        details?:{kind?:string;post_state?:{value?:unknown};
          after_action?:{steps?:Array<{label?:string;outcome?:string}>}}}};
      const details=e.partialResult?.details;
      const actual=details?.post_state?.value;
      const delivered=details?.after_action?.steps?.some(step=>
        step.label==='ValuePattern.SetValue'&&step.outcome==='succeeded');
      if(e.code!=='ACTION_FAILED'||details?.kind!=='post_action_verification'||
         !delivered||typeof actual!=='string'||typeof input.text!=='string')throw error;
      const comparison=compareDesktopText(input.text,actual);
      if(!comparison.equivalent)throw error;
      result=nativePostState('set-value',{
        action:'set-value',
        disposition:{delivery:'delivered_verified',retry:'unsafe'},
        post_state:{value:actual},
        details:{verification_scope:'application_normalized_text',exactTextMatch:comparison.exact,
          eolNormalized:comparison.eolNormalized,
          trailingNewlineDropped:comparison.trailingNewlineDropped,
          applicationCommit:'not_verified'}
      });
    }
  }else if(tool==='desktop_window'&&input.action==='focus'){
    result=await focusWindowWithPostcondition(input,args,signal);
  }else if(tool==='desktop_pointer'&&input.action==='hover'){
    result=await hoverWithRecovery(input,args,signal);
  }else if(tool==='desktop_app'&&input.action==='close'&&!input.force){
    try{result=await runNative(command,args,Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);}
    catch(error){
      if(process.platform!=='win32'||(error as {code?:string}).code!=='APP_NOT_FOUND')throw error;
      result=await closePackagedWindow(input,args,signal);
    }
  }else{
    result=await runNative(command,args,Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);
  }
  refOwnership.remember(result,grantId,sessionId);
  return {...result,desktop:{sessionId,engine:'agent-desktop',policy:desktopPolicy()}};
}
