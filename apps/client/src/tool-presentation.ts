import type {ToolName} from '@deskbeacon/protocol';
import type {ActivityEntry} from './presenter.js';
import {normalizeProcessStderr} from './terminal-errors.js';

/** One explicit presentation contract per MCP tool. No raw request bodies or secrets in table cells. */
export type Tone='default'|'muted'|'success'|'danger'|'warning'|'accent';
export type Segment={text:string;tone?:Tone};
export type ToolRow={toolLabel:string;action:Segment[];result:Segment[];readOnly?:boolean};
/** Only read-only tools are dimmed; commands, batches and arbitrary HTTP methods stay visible. */
const readTools=new Set(['device_list','device_info','workspace_info','fs_list','fs_stat',
 'fs_read','fs_read_many','fs_find','fs_grep','background_list','background_get',
 'background_output','operation_get','operation_output','transfer_download','transfer_status',
 'net_ports','net_probe','system_snapshot','system_processes','screen_capture']);
export function isReadOnlyTool(tool:string,request?:string|null):boolean{
 if(readTools.has(tool))return true;
 if(tool==='fs_archive'){const input=parse(request);return input.action==='list';}
 if(tool==='http_request'){const input=parse(request);return ['GET','HEAD','OPTIONS'].includes(String(input.method??'GET').toUpperCase());}
 return false;
}
type Fields=Record<string,any>;
type Template={label:string;action:(i:Fields,a:ActivityEntry)=>string;result:(r:Fields,i:Fields)=>Segment[]};
const part=(text:unknown,tone:Tone='muted'):Segment[]=>[{text:String(text??'—'),tone}];
function parse(raw?:string|null):Fields{
 try{const v=JSON.parse(raw??'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}
}
function value(v:unknown):string{return typeof v==='string'||typeof v==='number'?String(v):'';}
function clean(text:unknown,max=200){
 const input=value(text).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'')
  .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,' ')
  .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi,'$1 [redacted]')
  .replace(/\b(password|passwd|authorization|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]')
  .replace(/\b(sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,})\b/gi,'[redacted]')
  .replace(/https?:\/\/[^\s]+/gi,match=>safeUrl(match))
  .replace(/\s+/g,' ').trim();
 return input.length<=max?input:input.slice(0,max-1)+'…';
}
function safeUrl(v:unknown){
 try{const url=new URL(value(v));return url.origin+url.pathname;}catch{return value(v).replace(/[?#].*$/,'').replace(/\/\/[^/@]+@/,'//');}
}
function path(i:Fields){return clean(i.path??i.targetPath??i.sourcePath??i.archivePath??i.outputPath??i.targetDirectory,220);}
function filename(v:unknown){const s=clean(v,220);return s.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)??s;}
function count(v:unknown){return typeof v==='number'&&Number.isFinite(v)?v:undefined;}
function qty(n:unknown,unit:string){return String(count(n)??0)+' '+unit;}
function bytes(n:unknown){
 const v=count(n);
 if(v===undefined)return '—';
 if(v<1024)return v+' B';
 if(v<1048576)return (v/1024).toFixed(v<10240?1:0)+' KB';
 if(v<1073741824)return (v/1048576).toFixed(v<10485760?1:0)+' MB';
 return (v/1073741824).toFixed(1)+' GB';
}
function first(arr:unknown):Fields{return Array.isArray(arr)&&arr[0]&&typeof arr[0]==='object'?arr[0]:{};}
function task(i:Fields){return clean(i.backgroundTaskId??i.operationId??i.transferId,14);}
function listResult(r:Fields,key:string,unit:string){const list=r[key];return part(Array.isArray(list)?qty(list.length,unit)+(r.truncated?' · 已截断':''):r.totalMatches!==undefined?qty(r.totalMatches,unit):'已完成');}
function cmd(i:Fields):string{
 const c=i.command;
 if(!c||typeof c!=='object')return '';
 const v=c.mode==='shell'?c.script:[c.program,...(Array.isArray(c.args)?c.args:[])].join(' ');
 return clean(v,180);
}
function outputPreview(r:Fields){
 const candidates=[r.outputPreview,r.stdout,r.stderr,r.output,r.text];
 for(const candidate of candidates){
  if(typeof candidate!=='string'||!candidate.trim())continue;
  const lines=normalizeProcessStderr(candidate).split(/\r?\n/).map(line=>clean(line,140)).filter(Boolean);
  if(lines.length)return lines.at(-1)??'';
 }
 return '';
}
function commandResult(r:Fields):Segment[]{
 if(r.timedOut)return part('超时','danger');
 if(r.outputLimit)return part('输出上限','warning');
 if(r.spawnError)return part('启动失败 · '+clean(r.spawnError,80),'danger');
 const exit=count(r.exitCode);
 const preview=clean(r.errorSummary??outputPreview(r),140);
 if(exit!==undefined&&exit!==0)return part('退出 '+exit+(preview?' · '+preview:''),'danger');
 if(preview)return part(preview,'muted');
 if(exit!==undefined)return part('退出 '+exit,exit===0?'success':'danger');
 if(r.cancelled)return part('已取消','warning');
 return part('已完成');
}
function operationResult(r:Fields):Segment[]{
 if(typeof r.status==='string')return part('状态 '+clean(r.status,40));
 if(typeof r.state==='string')return part('状态 '+clean(r.state,40));
 return part('已查询');
}
function editResult(r:Fields):Segment[]{
 if(r.dryRun)return part('预检查通过 · 未写入','warning');
 const add=count(r.addedLines),remove=count(r.removedLines);
 if(add!==undefined&&remove!==undefined){
  const parts:Segment[]=[];
  parts.push({text:'+'+add,tone:'success'});
  parts.push({text:', ',tone:'muted'});
  parts.push({text:'-'+remove,tone:'danger'});
  const size=count(r.bytes??r.writtenBytes);
  if(size!==undefined)parts.push({text:', '+bytes(size).replace(' ','') ,tone:'muted'});
  return parts;
 }
 const replacements=count(r.replacements);
 if(replacements!==undefined)return part((r.changed===false?'无变化 · ':'已更新 · ')+replacements+' 处');
 if(r.writtenBytes!==undefined)return part('已写入 '+bytes(r.writtenBytes));
 return part(r.changed===false?'无变化':'已更新');
}
const templates:Record<ToolName,Template>={
 device_list:{label:'设备列表',action:()=> '已授权设备',result:r=>part(qty(r.devices?.length,'台设备')+(Array.isArray(r.devices)?' · '+r.devices.filter((d:Fields)=>d.state==='online').length+' 在线':''))},
 device_info:{label:'设备信息',action:i=>clean(i.deviceId,60),result:r=>part(clean(r.platform??r.os??r.deviceName??'已获取设备信息'))},
 workspace_open:{label:'创建工作区',action:i=>clean(i.cwd??i.path??'当前目录')+' · '+clean(i.shellProfile??'默认 Shell',32),result:r=>part('已创建 · '+clean(r.workspaceId,12))},
 workspace_info:{label:'工作区信息',action:i=>clean(i.workspaceId,12),result:r=>part(clean(r.cwd??'已获取工作区信息'))},
 workspace_cd:{label:'切换目录',action:i=>clean(i.cwd??i.path),result:r=>part('已切换'+(r.version!==undefined?' · v'+r.version:''))},
 fs_list:{label:'目录列表',action:i=>(path(i)||'当前目录')+' · 深度 '+(count(i.depth)??1),result:r=>part(qty(r.entries?.length??r.items?.length,'项')+(r.truncated?' · 已截断':''))},
 fs_stat:{label:'文件属性',action:i=>filename(i.paths?.[0])+' · '+qty(i.paths?.length,'个路径'),result:r=>part(qty(r.entries?.length??r.results?.length??r.files?.length??r.paths?.length,'项属性'))},
 fs_read:{label:'文件读取',action:i=>filename(i.path)+(i.lineOffset!==undefined?' · 第 '+(Number(i.lineOffset)+1)+' 行起':i.byteOffset?' · byte '+i.byteOffset:''),result:r=>part((r.linesRead!==undefined?qty(r.linesRead,'行')+' · ':'')+bytes(r.readBytes))},
 fs_read_many:{label:'批量读取',action:i=>filename(first(i.files).path)+' · '+qty(i.files?.length,'个文件'),result:r=>part((count(r.successCount)??r.files?.length??0)+' 成功'+(r.failureCount?' · '+r.failureCount+' 失败':'')+(r.bytesUsed?' · '+bytes(r.bytesUsed):''))},
 fs_find:{label:'文件查找',action:i=>clean(i.pattern??'*')+' · '+(path(i)||'当前目录'),result:r=>listResult(r,'paths','个文件')},
 fs_grep:{label:'内容搜索',action:i=>clean(i.pattern)+' · '+(path(i)||'当前目录'),result:r=>listResult(r,'matches','处匹配')},
 fs_write:{label:'文件写入',action:i=>filename(i.path)+' · '+clean(i.mode??'rewrite'),result:r=>part('写入 '+bytes(r.writtenBytes))},
 fs_edit:{label:'文件编辑',action:i=>filename(i.path)+' · '+(i.mode==='replace_many'?qty(i.replacements?.length,'处替换'):clean(i.mode??'replace')),result:editResult},
 fs_manage:{label:'文件管理',action:i=>filename(i.path??i.sourcePath??i.targetPath)+(i.destination?' → '+filename(i.destination):'')+' · '+clean(i.action??'manage'),result:r=>part(r.ok===false?'未完成':'已完成')},
 fs_archive:{label:'归档处理',action:i=>filename(i.outputPath??i.archivePath??i.sourcePaths?.[0])+' · '+clean(i.action??'archive')+(i.format?' · '+clean(i.format):''),result:r=>part(r.extracted!==undefined?qty(r.extracted,'项已解压'):r.entries?qty(r.entries.length,'项'):r.bytes!==undefined?'归档 '+bytes(r.bytes):'已完成')},
 exec_foreground:{label:'命令执行',action:(i,a)=>clean(a.description&&a.description!==a.tool?a.description:cmd(i),220)||'执行命令',result:commandResult},
 batch:{label:'批量操作',action:i=>qty(Array.isArray(i.stages)?i.stages.reduce((n:number,s:Fields)=>n+(s.calls?.length??0),0):0,'项操作')+' · '+qty(i.stages?.length,'阶段'),result:r=>part((r.completed??0)+' 成功 · '+(r.failed??0)+' 失败'+(r.skipped?' · '+r.skipped+' 跳过':''),r.failed?'danger':'muted')},
 exec_background:{label:'后台启动',action:(i,a)=>clean(a.description&&a.description!==a.tool?a.description:cmd(i))||'启动后台任务',result:r=>part('已启动'+(r.pid?' · PID '+r.pid:r.backgroundTaskId?' · '+clean(r.backgroundTaskId,12):''))},
 background_list:{label:'后台列表',action:i=>(i.state==='running'?'运行中':i.state==='exited'?'已退出':'全部')+' · 后台任务',result:r=>listResult(r,'tasks','个任务')},
 background_get:{label:'后台状态',action:i=>task(i),result:operationResult},
 background_output:{label:'后台日志',action:i=>task(i)+' · '+clean(i.stream??'输出'),result:r=>part((r.results?.length!==undefined?qty(r.results.length,'段日志'):r.lines?.length!==undefined?qty(r.lines.length,'行日志'):r.text?bytes(r.bytes??r.text.length):'已读取'))},
 background_input:{label:'后台输入',action:i=>task(i)+' · '+clean(i.signal??'stdin'),result:(r,i)=>part(r.sent===false?'未发送':i.signal==='ctrl_c'?'中断信号已发送':'输入已发送')},
 background_stop:{label:'后台停止',action:i=>task(i),result:r=>part(r.stopped===true?'已停止':r.stopped===false?'未停止':'已提交停止请求',r.stopped===false?'warning':'muted')},
 operation_get:{label:'操作记录',action:i=>task(i),result:operationResult},
 operation_output:{label:'操作输出',action:i=>task(i)+' · '+clean(i.stream??'输出'),result:r=>part(r.bytes!==undefined?'返回 '+bytes(r.bytes):r.text?'返回 '+bytes(r.text.length):'已读取')},
 transfer_upload:{label:'文件上传',action:i=>filename(i.targetPath)+' · '+bytes(i.expectedBytes),result:(r,i)=>part('已上传 '+bytes(r.writtenBytes??r.bytes??i.expectedBytes))},
 transfer_download:{label:'文件下载',action:i=>filename(i.sourcePath),result:r=>part('已返回 '+bytes(r.bytes??r.readBytes))},
 transfer_status:{label:'传输状态',action:i=>task(i),result:r=>part(clean(r.status??r.state??'已查询')+(r.totalBytes&&r.bytes!==undefined?' · '+Math.floor(r.bytes/r.totalBytes*100)+'%':''))},
 transfer_cancel:{label:'取消传输',action:i=>task(i),result:r=>part(r.cancelled===false?'未取消':'已取消')},
 net_ports:{label:'网络端口',action:i=>clean(i.protocol??'TCP')+' · '+clean(i.state??'监听'),result:r=>listResult(r,'connections','个连接')},
 net_probe:{label:'网络探测',action:i=>(i.mode==='dns'?'DNS · '+clean(i.hostname):clean(i.host)+(i.port?':'+i.port:'')),result:r=>part(r.connected===false||r.ok===false?'连接失败':r.connected===true?'连接成功':clean(r.address??r.host??'探测完成'),r.connected===false?'danger':'muted')},
 http_request:{label:'HTTP 请求',action:i=>clean(i.method??'GET')+' · '+safeUrl(i.url),result:r=>part('HTTP '+String(r.status??r.statusCode??'—'),Number(r.status??r.statusCode)>=400?'danger':'muted')},
 system_snapshot:{label:'系统概况',action:()=> 'CPU · 内存 · 磁盘',result:r=>part(r.cpuPercent!==undefined?'CPU '+r.cpuPercent+'%':r.cpu?.usage!==undefined?'CPU '+r.cpu.usage+'%':'系统状态已读取')},
 system_processes:{label:'系统进程',action:i=>clean(i.name??(i.pid?'PID '+i.pid:'全部')),result:r=>listResult(r,'processes','个进程')},
 screen_capture:{label:'屏幕截图',action:i=>(i.monitor!==undefined?'屏幕 '+(Number(i.monitor)+1):'默认屏幕'),result:r=>part((r.width??'—')+'×'+(r.height??'—')+(r.sizeBytes?' · '+bytes(r.sizeBytes):''))}
};
export const TOOL_LABELS=Object.fromEntries(Object.entries(templates).map(([name,template])=>[name,template.label])) as Record<ToolName,string>;
export function toolRow(a:ActivityEntry):ToolRow{
 const template=templates[a.tool as ToolName];
 // Historical records can contain the retired exec_batch tool; keep their intent readable.
 if(a.tool==='exec_batch')return {toolLabel:'旧版批处理',action:part(clean(a.description||'执行批处理'),'default'),result:part('历史批处理记录')};
 if(!template)return {toolLabel:'其他操作',action:part(clean(a.description??a.tool),'default'),result:part('未知工具')};
 const i=parse(a.request_json),wrapper=parse(a.result),r=wrapper.data&&typeof wrapper.data==='object'&&!Array.isArray(wrapper.data)?{...wrapper,...wrapper.data}:wrapper;
 let action='';
 try{action=clean(template.action(i,a),250);}catch{action=clean(a.description??a.tool);}
 const readOnly=isReadOnlyTool(a.tool,a.request_json);
 let result:Segment[];
 if(a.status==='running'||a.status==='accepted'||a.status==='started')result=part('进行中','warning');
 else if(a.status==='cancelled'||a.status==='stopped')result=part('已中止','warning');
 else if(a.status==='interrupted')result=part('执行中断 · 结果未知','warning');
 else if(a.status==='failed'||r.isError===true||r.error||r.spawnError)result=part(clean(r.error?.message??r.error??r.message??r.spawnError??'执行失败'),'danger');
 else{try{result=template.result(r,i);}catch{result=part('已完成');}}
 // Main ACTION text remains foreground; dot-separated qualifiers are metadata.
 const cut=action.indexOf(' · ');
 const actionSegments:Segment[]=cut<0?[{text:action||'—',tone:'default'}]:[
  {text:action.slice(0,cut),tone:'default'},
  {text:action.slice(cut),tone:'muted'}
 ];
 return {toolLabel:template.label,action:actionSegments,readOnly,result:result.map(seg=>({...seg,text:clean(seg.text,250)}))};
}
