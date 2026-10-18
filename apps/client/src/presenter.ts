// User-facing descriptions for every DeskBeacon MCP operation.
// Never display raw JSON, access tokens, inline file contents, or auth credentials.
export type ActivityEntry={
  id:string;grant_id:string;actor_name?:string|null;tool:string;description:string;status:string;time:number;
  cwd?:string|null;finished_at?:number|null;duration_ms?:number|null;
  request_json?:string|null;result?:string|null;
};
const verbs:Record<string,[string,string]>={
 device_info:['读取设备信息中','读取了设备信息'],device_list:['发现设备中','列出了设备'],
 workspace_open:['创建工作区中','创建了工作区'],workspace_info:['读取工作区中','读取了工作区'],
 workspace_cd:['切换目录中','切换了工作目录'],
 fs_list:['列出文件中','列出了文件'],fs_stat:['检查文件中','检查了文件'],
 fs_read:['读取文件中','读取了文件'],fs_read_many:['批量读取文件中','批量读取了文件'],fs_find:['查找文件中','查找了文件'],
 fs_grep:['搜索内容中','搜索了内容'],fs_write:['写入文件中','写入了文件'],
 fs_edit:['编辑文件中','编辑了文件'],fs_manage:['管理文件中','管理了文件'],
 fs_archive:['处理归档中','处理了归档'],
 exec_foreground:['执行命令中','执行了命令'],exec_batch:['执行批量命令中','执行了批量命令'],
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
  .replace(/[\x00-\x08\x0B-\x1F\x7F]/g,'').slice(0,limit);
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
   const c=a.tool==='exec_batch'?i.stages?.[0]?.commands?.[0]:command;
   if(c){const program=c.program||c.script||c.command||'';
     const text=[program,...(Array.isArray(c.args)?c.args:[])].map((v:any)=>safeText(String(v),250)).join(' ');
     if(text)lines.push(text);}
   if(a.tool==='exec_batch')lines.push(String(i.stages?.length??0)+' 个执行阶段');
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
