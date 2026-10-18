// User-facing descriptions for every DeskBeacon MCP operation.
// Never display raw JSON, access tokens, inline file contents, or auth credentials.
export type ActivityEntry={
  id:string;grant_id:string;actor_name?:string|null;tool:string;description:string;status:string;time:number;
  cwd?:string|null;finished_at?:number|null;duration_ms?:number|null;
  request_json?:string|null;result?:string|null;
};
export type ActivityDetail=Pick<ActivityEntry,'cwd'|'request_json'|'result'>;
const verbs:Record<string,[string,string]>={
 device_info:['读取设备信息中','读取了设备信息'],device_list:['发现设备中','列出了设备'],
 workspace_open:['创建工作区中','创建了工作区'],workspace_info:['读取工作区中','读取了工作区'],
 workspace_cd:['切换目录中','切换了工作目录'],
 fs_list:['列出文件中','列出了文件'],fs_stat:['检查文件中','检查了文件'],
 fs_read:['读取文件中','读取了文件'],fs_read_many:['批量读取文件中','批量读取了文件'],fs_find:['查找文件中','查找了文件'],
 fs_grep:['搜索内容中','搜索了内容'],fs_write:['写入文件中','写入了文件'],
 fs_edit:['编辑文件中','编辑了文件'],fs_manage:['管理文件中','管理了文件'],
 fs_archive:['处理归档中','处理了归档'],
 exec_foreground:['执行命令中','执行了命令'],
 exec_background:['启动后台任务中','启动了后台任务'],
 background_list:['查询后台任务中','查询了后台任务'],background_get:['检查后台任务中','检查了后台任务'],
 background_output:['读取任务输出中','读取了任务输出'],
 background_input:['发送任务输入中','发送了任务输入'],background_stop:['停止后台任务中','停止了后台任务'],
 operation_get:['查询操作记录中','查询了操作记录'],operation_output:['读取操作输出中','读取了操作输出'],
 transfer_upload:['上传文件中','上传了文件'],transfer_download:['下载文件中','下载了文件'],
 transfer_status:['查询传输状态中','查询了传输状态'],transfer_cancel:['取消传输中','取消了传输'],
 net_ports:['检查端口中','检查了端口'],net_probe:['测试连接中','测试了连接'],
 http_request:['发送网络请求中','发送了网络请求'],
 system_snapshot:['读取系统状态中','读取了系统状态'],
 system_processes:['查找系统进程中','查找了系统进程'],
 screen_capture:['截取屏幕中','截取了屏幕']
};
function json(raw?:string|null):Record<string,any>{
  if(!raw)return {};
  try{const value=JSON.parse(raw);return value&&typeof value==='object'?value:{};}catch{return {};}
}
export function actionLabel(a:ActivityEntry):string{
 const [active,done]=verbs[a.tool]??['执行操作中','执行了操作'];
 if(a.status==='failed')return done.replace(/了/g,'')+'失败';
 if(a.status==='cancelled')return '取消了操作';
 return a.status==='running'?active:done;
}
export function safeText(text:string,limit=190){
 return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'')
  .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,limit);
}
function pathValue(input:Record<string,any>,key:string):string{
 const val=input[key];return typeof val==='string'?safeText(val,220):'';
}
export function argumentLines(a:ActivityEntry):string[]{
 const i=json(a.request_json),command=i.command??{};
 const dir=pathValue(i,'path')||pathValue(i,'sourcePath')||pathValue(i,'targetPath')||
  (Array.isArray(i.paths)?i.paths.slice(0,2).map((p:any)=>safeText(String(p))).join(', '):'');
 const lines:string[]=[];
 if(dir)lines.push(dir);
 if(a.tool.startsWith('exec_')){
   const c=command;
   if(c){const program=c.program||c.script||c.command||'';
     const text=[program,...(Array.isArray(c.args)?c.args:[])].map((v:any)=>safeText(String(v),250)).join(' ');
     if(text)lines.push(text);}
 }else if(a.tool==='fs_grep'||a.tool==='fs_find'){
   if(i.pattern)lines.push('搜索: '+safeText(String(i.pattern)));
 }else if(a.tool==='http_request')lines.push(String(i.method??'GET')+' '+safeText(String(i.url??'')));
 else if(a.tool==='net_probe')lines.push([i.mode,i.host,i.hostname,i.port].filter(Boolean).join(' '));
 else if(a.tool==='fs_archive')lines.push('格式: '+String(i.format??'ZIP')+' · '+String(i.action??''));
 else if(a.tool==='fs_edit'){
   const patch=i.patch??i.patches??i.edits;
   if(patch){
     const value=typeof patch==='string'?patch:JSON.stringify(patch);
     const diff=value.split('\n');
     lines.push(...diff.filter(x=>x.startsWith('+')||x.startsWith('-')).slice(0,3).map(x=>safeText(x)));
     const added=diff.filter(x=>x.startsWith('+')&&!x.startsWith('+++')).length;
     const removed=diff.filter(x=>x.startsWith('-')&&!x.startsWith('---')).length;
     if(added||removed)lines.push('+'+added+' / -'+removed+' 行');
   }
 }else if(a.tool==='fs_read'){if(i.lineOffset!==undefined)lines.push('从第 '+i.lineOffset+' 行读取');}
 return lines.filter(Boolean);
}
export function resultLines(a:ActivityEntry):string[]{
 if(a.status==='running')return [];
 const r=json(a.result);
 if(a.status==='failed')return [safeText(String(r.error??'操作未成功'),250)];
 const lines:string[]=[];
 if(typeof r.exitCode==='number'||r.exitCode===null)lines.push('退出码: '+String(r.exitCode));
 if(typeof r.durationMs==='number')lines.push('执行用时: '+(r.durationMs/1000).toFixed(2)+'s');
 if(typeof r.writtenBytes==='number')lines.push('写入 '+r.writtenBytes+' 字节');
 if(typeof r.bytes==='number')lines.push('传输 '+r.bytes+' 字节');
 if(Array.isArray(r.entries))lines.push('包含 '+r.entries.length+' 项');
 if(Array.isArray(r.files))lines.push('文件 '+r.files.length+' 项'+(typeof r.failureCount==='number'?' · 失败 '+r.failureCount+' 项':''));
 if(Array.isArray(r.matches))lines.push('匹配 '+r.matches.length+' 项');
 for(const key of ['stdout','stderr']){
   if(typeof r[key]==='string'&&r[key]){
     lines.push(key==='stderr'?'错误输出:':'命令输出:');
     lines.push(...r[key].split(/\r?\n/).filter(Boolean).slice(0,14).map(x=>safeText(x,220)));
   }
 }
 if(r.backgroundTaskId)lines.push('任务 ID: '+safeText(String(r.backgroundTaskId)));
 if(r.path)lines.push(safeText(String(r.path)));
 if(r.cwd&&!lines.length)lines.push(safeText(String(r.cwd)));
 if(!lines.length)lines.push('已完成');
 return lines;
}
export function duration(ms:number):string{
 const sec=Math.max(0,Math.floor(ms/1000));
 const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;
 return h?String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):
 String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}

export type ActivityState='running'|'success'|'failed'|'stopped'|'interrupted'|'unknown';
export type ActivityPresentation={
 agent:string;tool:string;state:ActivityState;symbol:string;status:string;
 target:string;intent:string;summary:string;elapsed:string;command:string;
};

const shortTools:Record<string,string>={
 device_list:'设备',device_info:'读取',workspace_open:'工作区',workspace_info:'读取',workspace_cd:'切换',
 fs_list:'列表',fs_stat:'检查',fs_read:'读取',fs_read_many:'批量',fs_find:'查找',fs_grep:'搜索',
 fs_write:'写入',fs_edit:'编辑',fs_manage:'管理',fs_archive:'归档',
 exec_foreground:'执行',batch:'批量',exec_background:'后台',background_list:'后台',background_get:'后台',
 background_output:'读取',background_input:'输入',background_stop:'停止',operation_get:'查询',operation_output:'读取',
 transfer_upload:'上传',transfer_download:'下载',transfer_status:'传输',transfer_cancel:'取消',
 net_ports:'端口',net_probe:'探测',http_request:'请求',system_snapshot:'系统',system_processes:'进程',screen_capture:'截图'
};

function resultObject(a:ActivityEntry):Record<string,any>{
 const raw=json(a.result),data=raw.data;
 return data&&typeof data==='object'&&!Array.isArray(data)?{...raw,...data}:raw;
}
function inputObject(a:ActivityEntry):Record<string,any>{return json(a.request_json);}
function clean(value:unknown,limit=240):string{
 if(value===null||value===undefined)return '';
 return safeText(String(value),limit)
  .replace(/\b(Bearer)\s+[^\s,;]+/gi,'$1 [redacted]')
  .replace(/\b(authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|content|dataBase64|env|body|headers)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]');
}
function oneLine(value:unknown,limit=180):string{return clean(value,limit).replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();}
function previewLine(value:unknown,limit=180):string{
 const text=clean(value,limit+1).replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
 return text.length>limit?text.slice(0,limit-1)+'…':text;
}
function num(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)?value:undefined;}
function displayBytes(value:number):string{
 if(value<1024)return `${value} B`;
 const units=['KB','MB','GB'];let size=value/1024,index=0;
 while(size>=1024&&index<units.length-1){size/=1024;index++;}
 return `${size<10?size.toFixed(1):Math.round(size)} ${units[index]}`;
}
function shortId(value:unknown):string{return oneLine(value,18)||'—';}
function safeUrl(value:unknown):string{
 const raw=String(value??'');
 try{
  const url=new URL(raw);
  url.username='';url.password='';url.search='';url.hash='';
  return oneLine(url.toString().replace(/\/$/,url.pathname==='/'?'':'/'),240);
 }catch{return oneLine(raw.replace(/[?#].*$/,''),240);}
}
function commandScript(command:Record<string,any>,limit=8000):{lines:string[];truncated:boolean}{
 const raw=typeof command.script==='string'?command.script:'';
 const trimmed=raw.slice(0,limit);
 const value=clean(trimmed,limit).replace(/\r\n?/g,'\n');
 const lines=value.split('\n');
 const longLine=lines.some(line=>line.length>1000);
 return {lines:lines.map(line=>line.length>1000?line.slice(0,999)+'…':line),truncated:raw.length>limit||longLine};
}
function readableArg(value:string):string{
 return /^[\p{L}\p{N}_./:@%+=,-]+$/u.test(value)?value:JSON.stringify(value);
}
function argvCommand(command:Record<string,any>):string{
 if(command.mode==='shell')return oneLine(typeof command.script==='string'?command.script:'',240);
 const argv=[command.program,...(Array.isArray(command.args)?command.args:[])].filter(x=>typeof x==='string').map(String);
 for(let index=0;index<argv.length;index++){
  const flag=argv[index];
  if(flag===undefined)continue;
  if(!/^--?(?:.*[-_])?(?:token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|content|dataBase64|env|body|headers)(?:=|$)/i.test(flag))continue;
  const separator=flag.indexOf('=');
  if(separator>=0)argv[index]=flag.slice(0,separator+1)+'[redacted]';
  else if(index+1<argv.length)argv[++index]='[redacted]';
 }
 // Quote only when needed to make argument boundaries readable; this is a display preview, not shell syntax.
 const visible=argv.slice(0,24).map(readableArg);
 if(argv.length>visible.length)visible.push(`…(+${argv.length-visible.length} 参数)`);
 return visible.length?previewLine(visible.join(' '),320):'';
}
function elapsedText(ms:number|undefined):string{
 if(ms===undefined)return '—';
 const value=Math.max(0,ms);
 if(value<1000)return `${Math.round(value)}ms`;
 const totalSeconds=Math.floor(value/1000),seconds=totalSeconds%60,minutes=Math.floor(totalSeconds/60)%60,hours=Math.floor(totalSeconds/3600);
 if(hours)return `${hours}h${String(minutes).padStart(2,'0')}m`;
 if(totalSeconds>=60)return `${Math.floor(totalSeconds/60)}m${String(seconds).padStart(2,'0')}s`;
 return `${(value/1000).toFixed(1)}s`;
}
function elapsedFor(a:ActivityEntry,r:Record<string,any>,now:number):string{
 const stored=num(a.duration_ms)??num(r.durationMs);
 if(stored!==undefined)return elapsedText(stored);
 const end=num(a.finished_at)??(a.status==='running'?now:undefined);
 return end!==undefined?elapsedText(end-a.time):'—';
}
function isCancelled(a:ActivityEntry,r:Record<string,any>):boolean{
 return a.status==='cancelled'||a.status==='stopped'||r.cancelled===true||r.status==='cancelled'||r.state==='cancelled';
}
function hasFailedResult(a:ActivityEntry,r:Record<string,any>):boolean{
 if(a.status==='failed'||r.timedOut===true||r.outputLimit===true||Boolean(r.spawnError)||r.isError===true||Boolean(r.error))return true;
 if(typeof r.exitCode==='number'&&r.exitCode!==0)return true;
 if(a.tool==='fs_read_many'&&typeof r.failureCount==='number'&&r.failureCount>0)return true;
 if(typeof r.failed==='number'&&r.failed>0)return true;
 return Array.isArray(r.stages)&&r.stages.some((stage:any)=>Array.isArray(stage?.results)&&stage.results.some((item:any)=>item?.ok===false));
}
function stateFor(a:ActivityEntry,r:Record<string,any>):ActivityState{
 if(a.status==='interrupted')return 'interrupted';
 if(isCancelled(a,r))return 'stopped';
 if(hasFailedResult(a,r))return 'failed';
 if(a.status==='running'||a.status==='accepted'||a.status==='started')return 'running';
 if(a.status==='completed'||a.status==='success'||a.status==='succeeded')return 'success';
 return 'unknown';
}
function statusFor(state:ActivityState,r:Record<string,any>):string{
 if(state==='running')return '进行中';
 if(state==='success')return '成功';
 if(state==='stopped')return '已停止';
 if(state==='interrupted')return '执行中断';
 if(state==='unknown')return '未知';
 if(r.timedOut===true)return '超时';
 if(r.outputLimit===true)return '输出超限';
 if(r.spawnError)return '启动失败';
 if(typeof r.exitCode==='number'&&r.exitCode!==0)return `退出码 ${r.exitCode}`;
 if(typeof r.failureCount==='number'&&r.failureCount>0)return `${r.failureCount} 项失败`;
 return '失败';
}
function symbolFor(state:ActivityState):string{return state==='running'?'⠹':state==='success'?'✓':state==='failed'?'✗':state==='stopped'?'■':state==='interrupted'?'!':'?';}
function targetFor(tool:string,i:Record<string,any>):string{
 const path=oneLine(i.path??i.sourcePath??i.targetPath??i.archivePath??i.outputPath??i.targetDirectory,220);
 const command=i.command&&typeof i.command==='object'?argvCommand(i.command as Record<string,any>):'';
 switch(tool){
  case 'device_list':return '已授权设备';case 'device_info':return '设备信息';
  case 'workspace_open':case 'workspace_cd':return path||'工作目录';case 'workspace_info':return `工作区 ${shortId(i.workspaceId)}`;
  case 'fs_stat':return Array.isArray(i.paths)?`${i.paths.length} 个路径 · ${oneLine(i.paths[0],160)}`:'文件属性';
  case 'fs_read_many':return Array.isArray(i.files)?`${i.files.length} 个文件 · ${oneLine(i.files[0]?.path,160)}`:'多个文件';
  case 'fs_find':case 'fs_grep':return `${path||'当前目录'}${i.pattern?` · ${oneLine(i.pattern,70)}`:''}`;
  case 'fs_archive':return `${oneLine(i.action,30)||'归档'} · ${path||'归档文件'}${Array.isArray(i.sourcePaths)?` · ${i.sourcePaths.length} 个来源`:''}`;
  case 'fs_manage':return `${path||'文件操作'}${i.destination?` → ${oneLine(i.destination,160)}`:''}`;
  case 'exec_foreground':case 'exec_background':return command||'命令';
  case 'batch':{
   const stages=Array.isArray(i.stages)?i.stages:[];const calls=stages.reduce((total,s)=>total+(Array.isArray(s?.calls)?s.calls.length:0),0);
   return `${calls} 个调用 · ${stages.length} 个阶段`;
  }
  case 'background_list':return oneLine(i.state??'全部后台任务',100);
  case 'background_get':case 'background_output':case 'background_input':case 'background_stop':return `任务 ${shortId(i.backgroundTaskId)}`;
  case 'operation_get':case 'operation_output':return `操作 ${shortId(i.operationId)}`;
  case 'transfer_upload':return path||'上传文件';case 'transfer_download':return path||'下载文件';
  case 'transfer_status':case 'transfer_cancel':return `传输 ${shortId(i.transferId)}`;
  case 'net_ports':return `${oneLine(i.protocol??'TCP',20)} · ${oneLine(i.state??'监听',20)}${i.port?` · ${i.port}`:''}`;
  case 'net_probe':return i.mode==='dns'?`DNS ${oneLine(i.hostname,150)}`:`${oneLine(String(i.mode??'网络').toUpperCase(),20)} ${oneLine(i.host,120)}${i.port?`:${i.port}`:''}`;
  case 'http_request':return `${oneLine(i.method??'GET',12)} ${safeUrl(i.url)}`;
  case 'system_snapshot':return '系统概况';case 'system_processes':return `进程${i.name?` · ${oneLine(i.name,80)}`:''}${i.pid?` · PID ${i.pid}`:''}`;
  case 'screen_capture':return `屏幕${i.monitor===undefined?'':` ${Number(i.monitor)+1}`}${i.rect?` · ${i.rect.width}×${i.rect.height}`:''}`;
  default:return path||oneLine(i.workspaceId??i.deviceId,160)||'—';
 }
}
function summaryFor(tool:string,r:Record<string,any>):string{
 const pieces:string[]=[];
 if(typeof r.statusCode==='number')pieces.push(`HTTP ${r.statusCode}`);
 else if(tool==='http_request'&&typeof r.status==='number')pieces.push(`HTTP ${r.status}`);
 if(tool==='exec_foreground'||typeof r.exitCode==='number'||r.exitCode===null){
  if(r.timedOut===true)pieces.push('超时');
  else if(r.outputLimit===true)pieces.push('输出超限');
  else if(r.spawnError)pieces.push('启动失败');
  else if(r.exitCode!==undefined)pieces.push(`退出码 ${r.exitCode===null?'空':r.exitCode}`);
 }
 if(tool==='batch'||(typeof r.completed==='number'&&typeof r.failed==='number'))pieces.push(`${num(r.completed)??0} 成功 · ${num(r.failed)??0} 失败${typeof r.skipped==='number'?` · ${r.skipped} 跳过`:''}`);
 if(Array.isArray(r.files))pieces.push(`${r.files.length} 个文件${typeof r.successCount==='number'?` · ${r.successCount} 成功`:''}${typeof r.failureCount==='number'?` · ${r.failureCount} 失败`:''}`);
 if(Array.isArray(r.matches))pieces.push(`${r.matches.length} 项匹配${r.truncated?' · 有截断':''}`);
 if(Array.isArray(r.entries))pieces.push(`${r.entries.length} 项${r.truncated?' · 有截断':''}`);
 if(Array.isArray(r.paths))pieces.push(`${r.paths.length} 个路径${r.truncated?' · 有截断':''}`);
 if(Array.isArray(r.processes))pieces.push(`${r.processes.length} 个进程${typeof r.totalMatches==='number'?` · 共 ${r.totalMatches} 个`:''}`);
 if(Array.isArray(r.connections))pieces.push(`${r.connections.length} 个连接${r.truncated?' · 有截断':''}`);
 if(Array.isArray(r.tasks))pieces.push(`${r.tasks.length} 个后台任务`);
 if(Array.isArray(r.devices))pieces.push(`${r.devices.length} 台设备`);
 if(Array.isArray(r.records))pieces.push(`${r.records.length} 条记录`);
 if(typeof r.extracted==='number')pieces.push(`解压 ${r.extracted} 项`);
 if(typeof r.state==='string')pieces.push(`状态 ${oneLine(r.state,30)}`);
 if(typeof r.stopped==='boolean')pieces.push(r.stopped?'已停止':'未停止');
 if(typeof r.writtenBytes==='number')pieces.push(`写入 ${displayBytes(r.writtenBytes)}`);
 if(typeof r.readBytes==='number')pieces.push(`读取 ${displayBytes(r.readBytes)}`);
 if(typeof r.bytes==='number')pieces.push(`${tool==='fs_archive'?'归档':tool==='fs_edit'?'更新':'传输'} ${displayBytes(r.bytes)}`);
 if(typeof r.expandedBytes==='number')pieces.push(`展开 ${displayBytes(r.expandedBytes)}`);
 if(typeof r.sizeBytes==='number')pieces.push(`图片 ${displayBytes(r.sizeBytes)}`);
 if(typeof r.durationMs==='number')pieces.push(`${elapsedText(r.durationMs)}`);
 if(typeof r.width==='number'&&typeof r.height==='number')pieces.push(`${r.width}×${r.height}`);
 if(typeof r.connected==='boolean')pieces.push(r.connected?'连接成功':'连接失败');
 if(typeof r.ok==='boolean'&&tool==='http_request')pieces.push(r.ok?'请求成功':'请求失败');
 if(typeof r.error==='string'&&pieces.length===0)pieces.push(oneLine(r.error,120));
 return oneLine(pieces.join(' · ')||'已完成',220);
}
function commandFor(i:Record<string,any>):string{
 const command=i.command&&typeof i.command==='object'?argvCommand(i.command as Record<string,any>):'';
 return command?previewLine(command,300):'';
}
/** A compact, secret-conscious row model shared by the activity table and detail pane. */
export function activityPresentation(a:ActivityEntry,now:number):ActivityPresentation{
 const i=inputObject(a),r=resultObject(a),state=stateFor(a,r);
 const actor=oneLine(a.actor_name,100);
 const grant=oneLine(a.grant_id,40);
 const target=Object.keys(i).length?targetFor(a.tool,i):oneLine(a.description||a.tool,220)||'—';
 return {
  agent:actor||`Agent ${grant.slice(0,8)||'unknown'}`,
  tool:shortTools[a.tool]??'操作',state,symbol:symbolFor(state),status:statusFor(state,r),
  target:previewLine(target,220),intent:oneLine(a.description||a.tool,180),
  summary:a.result===undefined?'':summaryFor(a.tool,r),
  elapsed:elapsedFor(a,r,now),command:commandFor(i)
 };
}

function inputDetailLines(tool:string,i:Record<string,any>):string[]{
 const lines:string[]=[];
 if(tool==='fs_read_many'&&Array.isArray(i.files)){
  lines.push(`文件数：${i.files.length}`);
  for(const item of i.files.slice(0,8))if(item?.path)lines.push(`文件：${oneLine(item.path,220)}`);
 }else if(tool==='fs_stat'&&Array.isArray(i.paths)){
  lines.push(`路径数：${i.paths.length}`);for(const path of i.paths.slice(0,8))lines.push(`路径：${oneLine(path,220)}`);
 }else if(tool==='http_request'){
  lines.push(`请求：${oneLine(i.method??'GET',12)} ${safeUrl(i.url)}`);
  if(i.body!==undefined)lines.push('请求正文：已隐藏');
 }else if(tool==='batch'&&Array.isArray(i.stages)){
  for(const [index,stage] of i.stages.entries()){
   const calls=Array.isArray(stage?.calls)?stage.calls:[];
   lines.push(`阶段 ${index+1}：${calls.length} 个调用${stage?.parallel?'（并行）':'（顺序）'}`);
   for(const call of calls.slice(0,6))lines.push(`调用：${oneLine(call?.tool,50)} · ${oneLine(call?.id,40)}`);
  }
 }else if(tool==='screen_capture'){
  lines.push(`格式：${oneLine(i.format??'jpeg',12)} · 最大 ${num(i.maxWidth)??1920}×${num(i.maxHeight)??1080}`);
  if(i.rect)lines.push(`区域：${i.rect.x},${i.rect.y} · ${i.rect.width}×${i.rect.height}`);
 }else if(tool==='fs_read'){
  lines.push(`读取范围：${num(i.maxBytes)??65536} 字节`);
  if(i.lineOffset!==undefined)lines.push(`起始行：${num(i.lineOffset)}`);
 }else if(tool==='fs_write'||tool==='fs_edit'){
  lines.push(`操作：${oneLine(i.mode,40)||'更新文件'} · 文件内容已隐藏`);
 }else if(tool==='transfer_upload'){
  if(typeof i.expectedBytes==='number')lines.push(`上传大小：${displayBytes(i.expectedBytes)}`);
  lines.push('上传数据：已隐藏');
 }else if(tool==='background_input')lines.push('输入内容：已隐藏');
 if(tool==='http_request'&&i.headers)lines.push('请求头：已隐藏');
 return lines;
}
function outputDetailLines(label:string,value:unknown,knownBytes?:unknown,previewTruncated=false,maxLines=40):string[]{
 const text=typeof value==='string'?value:'';
 const actualBytes=new TextEncoder().encode(text).byteLength;
 const bytes=typeof knownBytes==='number'&&Number.isFinite(knownBytes)?knownBytes:actualBytes;
 const lines=[`${label} · ${displayBytes(bytes)}${text.length===0?' · 空':''}`];
 if(!text){if(previewTruncated||bytes>actualBytes)lines.push('输出预览已截断或不完整；按 o 查看本地日志');return lines;}
 const rows=text.replace(/\r\n?/g,'\n').split('\n').filter(line=>line.length>0);
 let clippedLine=false;
 lines.push(...rows.slice(0,maxLines).map(row=>{
  if(row.length>500)clippedLine=true;
  return oneLine(row,500);
 }));
 if(rows.length>maxLines||clippedLine||previewTruncated||bytes>actualBytes)
  lines.push('输出预览已截断或不完整；按 o 查看本地日志');
 return lines;
}
function resultDetailLines(tool:string,r:Record<string,any>,i:Record<string,any>):string[]{
 const lines:string[]=[];
 if(typeof r.error==='string')lines.push(`错误：${oneLine(r.error,500)}`);
 if(typeof r.errorMessage==='string')lines.push(`错误：${oneLine(r.errorMessage,500)}`);
 if(tool==='exec_foreground'){
  if(r.exitCode!==undefined)lines.push(`退出码：${r.exitCode===null?'空':String(r.exitCode)}`);
  if(r.timedOut===true)lines.push('任务因超时停止');
  if(r.outputLimit===true)lines.push('输出达到执行上限，按 o 查看本地日志');
  if(r.previewTruncated===true)lines.push('历史输出预览已截断，按 o 查看本地日志');
  if(r.spawnError)lines.push(`进程启动错误：${oneLine(r.spawnError,400)}`);
  if(typeof r.stdout==='string'||r.stdoutBytes!==undefined)lines.push(...outputDetailLines('stdout',r.stdout,r.stdoutBytes));
  if(typeof r.stderr==='string'||r.stderrBytes!==undefined)lines.push(...outputDetailLines('stderr',r.stderr,r.stderrBytes));
  if(typeof r.outputPreview==='string')lines.push(...outputDetailLines('历史输出预览',r.outputPreview,undefined,r.previewTruncated===true));
 }else if(tool==='background_output'&&Array.isArray(r.results)){
  for(const [index,item] of r.results.entries()){
   const label=item?.stream==='stderr'||i.stream==='stderr'?'stderr':item?.stream==='stdout'||i.stream==='stdout'?'stdout':index===0?'stdout':'stderr';
   lines.push(...outputDetailLines(label,item?.text,item?.bytes,item?.hasMore===true||item?.truncated===true));
  }
 }else if(tool==='operation_output'&&Array.isArray(r.results)){
  for(const item of r.results)lines.push(...outputDetailLines(item?.stream==='stderr'?'stderr':'stdout',item?.text,item?.bytes,item?.truncated===true));
 }else if(tool==='fs_read_many'&&Array.isArray(r.files)){
  for(const file of r.files.slice(0,8)){
   if(file?.path)lines.push(`文件：${oneLine(file.path,220)}`);
   if(typeof file?.readBytes==='number')lines.push(`读取：${displayBytes(file.readBytes)}`);
   if(typeof file?.error==='string')lines.push(`错误：${oneLine(file.error,250)}`);
  }
 }else if(tool==='batch'&&Array.isArray(r.stages)){
  for(const [index,stage] of r.stages.entries())for(const item of (Array.isArray(stage?.results)?stage.results:[]).slice(0,6)){
   const outcome=item?.ok?'成功':'失败';
   lines.push(`阶段 ${index+1} · ${oneLine(item?.tool,40)}：${outcome}${item?.error?.message?` · ${oneLine(item.error.message,180)}`:''}`);
  }
 }else if(tool==='http_request'){
  if(typeof r.status==='number')lines.push(`HTTP 状态：${r.status}`);
  if(typeof r.durationMs==='number')lines.push(`请求用时：${elapsedText(r.durationMs)}`);
  if(typeof r.truncated==='boolean'&&r.truncated)lines.push('响应正文已截断');
 }else if(tool==='screen_capture'){
  if(typeof r.width==='number'&&typeof r.height==='number')lines.push(`图像尺寸：${r.width}×${r.height}`);
  if(typeof r.sizeBytes==='number')lines.push(`图像大小：${displayBytes(r.sizeBytes)}`);
  lines.push('图像数据：已隐藏');
 }else if(tool==='fs_read'){
  if(typeof r.readBytes==='number')lines.push(`读取：${displayBytes(r.readBytes)}`);
  if(typeof r.totalBytes==='number')lines.push(`文件大小：${displayBytes(r.totalBytes)}`);
  lines.push('文件内容：已隐藏');
 }else if(tool==='fs_grep'&&Array.isArray(r.matches)){
  lines.push(`匹配数：${r.matches.length}${r.truncated?' · 结果已截断':''}`);
 }else if(tool==='transfer_download'){
  if(typeof r.bytes==='number')lines.push(`下载大小：${displayBytes(r.bytes)}`);
  lines.push('文件数据：已隐藏');
 }
 if(!lines.length)lines.push(`结果：${summaryFor(tool,r)}`);
 return lines;
}
/** Expanded, bounded, readable detail text; binary and inline file content stay hidden. */
export function detailLines(a:ActivityEntry):string[]{
 const i=inputObject(a),r=resultObject(a),presentation=activityPresentation(a,num(a.finished_at)??a.time);
 const elapsed=num(a.duration_ms)??num(r.durationMs)??(num(a.finished_at)!==undefined?num(a.finished_at)!-a.time:undefined);
 const lines:string[]=[];
 lines.push(`来源：${presentation.agent} · ${new Date(a.time).toLocaleString()}`);
 if(a.cwd)lines.push(`目录：${oneLine(a.cwd,260)}`);
 lines.push(`意图：${presentation.intent}`);
 if(presentation.target&&presentation.target!=='—')lines.push(`目标：${presentation.target}`);
 if(i.command?.mode==='shell'){
  const script=commandScript(i.command);
  lines.push('命令脚本预览：');
  lines.push(...script.lines.map(line=>clean(line,1000).replace(/\t/g,'  ')));
  if(script.truncated)lines.push('脚本展示已截断');
 }else if(presentation.command)lines.push(`命令预览：${presentation.command}`);
 lines.push(...inputDetailLines(a.tool,i));
 lines.push(`状态：${presentation.status}${elapsed!==undefined?` · 用时 ${elapsedText(elapsed)}`:''}`);
 if(presentation.state!=='running')lines.push(...resultDetailLines(a.tool,r,i));
 return lines;
}
