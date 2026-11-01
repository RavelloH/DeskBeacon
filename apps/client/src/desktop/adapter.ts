import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {desktopExecutable} from './executable.js';
import {desktopPolicy,requireDesktopPermission} from './policy.js';

type Input=Record<string,any>;
// Explicit native sessions are owned by one OAuth grant and are never global MCP capabilities.
const ownedSessions=new Map<string,string>();
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
 if(session)await runNative('session',['end',session],10000).catch(()=>{});
}
/** The native manifests are auxiliary runtime state, never the source of operation history. */
export async function disposeDesktopSessions():Promise<void>{
 await stopSharedCursor();
 const sessions=[...ownedSessions.keys()];
 ownedSessions.clear();
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
      if(input.action==='launch')enabled(args,'--activate',input.activate);
      else enabled(args,'--force',input.force);
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
  const result=await runNative(command,args,Math.min(input.timeoutMs??15000,120000)+2500,160*1024,signal);
  return {...result,desktop:{sessionId,engine:'agent-desktop',policy:desktopPolicy()}};
}
