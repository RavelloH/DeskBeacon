import {createPatch} from 'diff';
import {activityPresentation,type ActivityEntry} from './presenter.js';
import {toolRow,type Tone,type Segment} from './tool-presentation.js';
import {cellWidth,fit,wrapLines} from './tui-layout.js';
import {highlightCodeLines,languageForPath,languageForCommand,type CodeSpan} from './syntax-highlight.js';
import {normalizeProcessStderr} from './terminal-errors.js';

export type DetailLine={text:string;tone?:Tone;bold?:boolean;italic?:boolean;label?:string;section?:string;syntax?:CodeSpan[]|undefined;
 sourceLine?:number|null;continued?:boolean;lineDigits?:number};
type Fields=Record<string,any>;
const line=(text:string,tone:Tone='default',bold=false,italic=false):DetailLine=>({text,tone,bold,italic});
const label=(key:string,value:unknown,tone:Tone='default'):DetailLine=>({text:clean(String(value??'—'),1000),label:key,tone});
const section=(title:string):DetailLine=>({text:title,section:title,tone:'muted',bold:true});
const combined=(segments:Segment[])=>segments.map(s=>s.text).join('');
const parse=(raw?:string|null):Fields=>{try{const v=JSON.parse(raw??'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};
function clean(raw:string,max=300):string{
 const scrubbed=raw.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'')
  .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi,'$1 [redacted]')
  .replace(/\b(password|passwd|authorization|secret|token|api[_-]?key|private[_-]?key|dataBase64)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]')
  .replace(/\b(sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,})\b/gi,'[redacted]')
  .replace(/https?:\/\/[^\s]+/gi,match=>{try{const u=new URL(match);return u.origin+u.pathname;}catch{return match.split(/[?#]/)[0]??'';}})
  .replace(/\r/g,'');
 return scrubbed.length>max?scrubbed.slice(0,max)+' ...剩余 '+(scrubbed.length-max)+' 字符':scrubbed;
}
/** Full inspector blocks do not impose the summary's 280-line/64K-character cap. */
export function fullNumberedBlock(raw:unknown,language?:string,startLine:number|null=1):DetailLine[]{
 return numberedBlock(raw,language,startLine,Infinity,Infinity);
}
export function numberedBlock(raw:unknown,language?:string,startLine:number|null=1,
 maxLines=280,maxChars=64000):DetailLine[]{
 if(typeof raw!=='string')return [line('（内容不可用）','muted',false,true)];
 const normalized=raw.replace(/\r\n?/g,'\n');
 const text=normalized.slice(0,maxChars),lines=text.split('\n');
 const displayedSource=lines.slice(0,maxLines);
 const source=displayedSource.map(value=>clean(value,maxLines===Infinity&&maxChars===Infinity?Infinity:500).replace(/\t/g,'  '));
 const lineDigits=startLine===null?1:String(startLine+Math.max(0,source.length-1)).length;
 const highlighted=language?highlightCodeLines(source,language):undefined;
 const result:DetailLine[]=source.map((v,index)=>{
  if(highlighted)return {...line(v,'muted'),syntax:highlighted[index],sourceLine:startLine===null?null:startLine+index,lineDigits};
  const tone:Tone=v.startsWith('+++')||v.startsWith('+')?'success':
   v.startsWith('---')||v.startsWith('-')?'danger':v.startsWith('@@')?'warning':'default';
  const comment=/^\s*(\/\/|#\s)/.test(v);
  return {...line(v,comment?'muted':tone,v.startsWith('@@'),comment),sourceLine:startLine===null?null:startLine+index,lineDigits};
 });
 const shown=displayedSource.join('\n').length;
 const missingChars=Math.max(0,normalized.length-shown);
 // Count omitted *source* lines, including lines excluded by maxChars.
 // lines here is only the maxChars prefix, so its length is insufficient.
 let missingLines=0;
 for(let i=shown;i<normalized.length;i++)if(normalized.charCodeAt(i)===10)missingLines++;
 if(missingLines>0||missingChars>0)
  result.push(line('摘要未展示：剩余 '+(missingLines>0?missingLines+' 行'+(missingChars>0?' / ':''):'')+
   (missingChars>0?missingChars+' 字符':'')+'（仅摘要显示省略；输入/输出原文请切换对应视图）','warning'));

 return result;
}
function records(items:unknown,mapper:(v:Fields,n:number)=>string):DetailLine[]{
 if(!Array.isArray(items))return [line('（无记录）','muted',false,true)];
 const visible=items.slice(0,120).map((item,n)=>{
  try{return line(clean(mapper(item,n),380),item?.error?'danger':'default');}
  catch{return line((n+1)+'. 记录','muted');}
 });
 if(items.length>120)visible.push(line('...剩余 '+(items.length-120)+' 行','warning'));
 return visible;
}
const loc=(x:Fields)=>x.path??x.name??x.sourcePath??x.filename??'';
const cmd=(x:Fields)=>{const c=x.command;if(!c||typeof c!=='object')return '';return c.mode==='shell'?String(c.script??''):[c.program,...(Array.isArray(c.args)?c.args:[])].join(' ');};

function contentFor(a:ActivityEntry,i:Fields,r:Fields):DetailLine[]{
 const out:DetailLine[]=[];
 const meta=(fields:[string,unknown][])=>out.push(...fields.filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>label(k,v)));
 const content=(title:string,text:unknown,language?:string,startLine:number|null=1)=>
  out.push(section(title),...numberedBlock(text,language,startLine));
 const list=(title:string,items:unknown,format:(v:Fields,n:number)=>string)=>out.push(section(title),...records(items,format));
 switch(a.tool){
  case 'fs_edit':{
   meta([['PATH',i.path],['MODE',i.mode],['MATCHES',r.replacements],['SHA256',r.sha256],['DRY RUN',r.dryRun]]);
   const edits=i.mode==='replace_many'&&Array.isArray(i.replacements)?i.replacements:[i];
   const patches=i.mode==='patch'?[String(i.patch??'')]:edits.slice(0,40)
    .filter((v:Fields)=>typeof v.oldText==='string'&&typeof v.newText==='string')
    .map((v:Fields,n:number)=>createPatch(String(i.path??'file')+' #'+(n+1),v.oldText,v.newText,'before','after',{context:2}));
   content('DIFF  '+(r.addedLines!==undefined?'+++ '+r.addedLines+' ':'')+(r.removedLines!==undefined?'--- '+r.removedLines:''),patches.join('\n'));
   break;
  }
  case 'fs_write':{
   meta([['PATH',i.path],['MODE',i.mode],['BYTES',r.writtenBytes],['SHA256',r.sha256]]);
   const heading=i.mode==='append'?'APPENDED CONTENT':'FILE CONTENT';
   // Always highlight the actual text sent by this write request, never the
   // post-write file contents. Binary/base64 and legacy redacted histories
   // cannot be treated as source code.
   if(typeof i.content==='string'&&i.content!=='[redacted]'&&i.encoding!=='base64')
    content(heading,i.content,languageForPath(i.path),i.mode==='append'?null:1);
   else out.push(section(heading),line('历史记录未保存可预览的写入文本','muted',false,true));
   break;
  }
  case 'fs_read':
   meta([['PATH',i.path],['LINES',r.linesRead],['BYTES',r.readBytes],['MORE',r.truncated]]);
   // Display only the content returned to the agent by this exact read call.
   // Never reopen the path: the file may have changed and the requested range
   // may have been only a few lines or bytes.
   if(typeof r.content==='string'&&r.content!=='[redacted]'){
    const offset=r.lineOffset??i.lineOffset;
    const start=Number.isSafeInteger(offset)?Number(offset)+1:
      Number(i.byteOffset??0)>0?null:1;
    content('FILE CONTENT',r.content,languageForPath(i.path),start);
   }
   else out.push(section('FILE CONTENT'),line('历史记录未保存此次读取的正文','muted',false,true));
   break;
  case 'fs_read_many':
   meta([['SUCCESS',r.successCount],['FAILED',r.failureCount],['BYTES',r.bytesUsed]]);
   for(const file of (Array.isArray(r.files)?r.files:[]).slice(0,20)){
    out.push(section(clean(String(loc(file)),100)));
    out.push(...(file.error?[line(clean(String(file.error)),'danger')]:
     typeof file.content==='string'&&file.content!=='[redacted]'?numberedBlock(file.content,
      languageForPath(loc(file)),Number.isSafeInteger(file.lineOffset)?file.lineOffset+1:
      Number(i.files?.find((f:Fields)=>f.path===file.path)?.byteOffset??0)>0?null:
      (Number(i.files?.find((f:Fields)=>f.path===file.path)?.lineOffset??0)+1),45,4000):
     [line('历史记录未保存此次读取的正文','muted',false,true)]));
   }break;
  case 'fs_grep':
   meta([['PATTERN',i.pattern],['PATH',i.path],['MATCHES',r.totalMatches??r.matches?.length],['MORE',r.truncated]]);
   out.push(section('MATCHES'),...records(r.matches,(x,n)=>(n+1)+'. '+loc(x)+':'+(x.lineNumber??x.line??'?')+'  '+(x.text??x.content??x.lineText??'')).map(row=>({...row,tone:row.tone==='danger'?'danger':'muted' as Tone})));break;
  case 'fs_find':
   meta([['PATTERN',i.pattern],['ROOT',i.path]]);
   list('FILES',r.paths,(x,n)=>(n+1)+'. '+(typeof x==='string'?x:loc(x)));break;
  case 'fs_list':case 'fs_stat':
   meta([['PATH',i.path],['DEPTH',i.depth],['MORE',r.truncated]]);
   list('DIRECTORY',r.entries,(x,n)=>(n+1)+'. '+loc(x)+'  '+(x.directory?'DIR':x.type??'')+'  '+(x.size??x.sizeBytes??'')+' '+(x.error??''));break;
  case 'fs_manage':
   meta([['ACTION',i.action],['FROM',i.path??i.sourcePath],['TO',i.destination??i.targetPath],['RESULT',r.ok===false?'未完成':'成功']]);break;
  case 'fs_archive':
   meta([['ACTION',i.action],['ARCHIVE',i.archivePath??i.outputPath],['FORMAT',i.format],['ITEMS',r.extracted??r.entries?.length]]);
   if(r.entries)list('ENTRIES',r.entries,(x,n)=>(n+1)+'. '+loc(x)+'  '+(x.size??''));break;
  case 'exec_foreground':case 'exec_background':
   meta([['CWD',i.command?.cwd??a.cwd],['EXIT',r.exitCode],['PID',r.pid],['TIMEOUT',r.timedOut]]);
   content('COMMAND',cmd(i),languageForCommand(i.command));
   if(r.stdout||r.outputPreview)content('STDOUT',r.stdout??normalizeProcessStderr(r.outputPreview));
   if(r.stderr)content('STDERR',normalizeProcessStderr(r.stderr));break;
  case 'batch':
   meta([['STAGES',i.stages?.length],['DONE',r.completed],['FAILED',r.failed],['SKIPPED',r.skipped]]);
   for(const [index,stage] of (Array.isArray(r.stages)?r.stages:[]).slice(0,20).entries())
    list('STAGE '+(index+1),stage.results,(x,n)=>(n+1)+'. '+(x.id??x.tool??'')+'  '+(x.ok?'OK':'FAILED'));
   break;
  case 'http_request':
   meta([['METHOD',i.method],['URL',i.url],['HTTP',r.status??r.statusCode],['BYTES',r.bytes??r.readBytes]]);
   if(r.text||r.outputPreview)content('RESPONSE',r.text??r.outputPreview);break;
  case 'net_ports':
   list('PORTS',r.connections,(x,n)=>(n+1)+'. '+(x.localAddress??'')+':'+(x.localPort??'')+'  '+(x.state??''));break;
  case 'net_probe':
   meta([['MODE',i.mode],['HOST',i.host??i.hostname],['PORT',i.port],['CONNECTED',r.connected??r.ok],['LATENCY',r.latencyMs]]);break;
  case 'device_list':
   list('DEVICES',r.devices,(x,n)=>(n+1)+'. '+(x.label??x.deviceId??'')+'  '+(x.state??''));break;
  case 'device_info':case 'workspace_open':case 'workspace_info':case 'workspace_cd':
   meta([['DEVICE',i.deviceId],['WORKSPACE',r.workspaceId??i.workspaceId],['DIRECTORY',r.cwd??i.path],['PLATFORM',r.platform]]);break;
  case 'background_list':
   list('TASKS',r.tasks,(x,n)=>(n+1)+'. '+(x.description??x.id??'')+'  '+(x.status??''));break;
  case 'background_get':case 'background_stop':case 'background_input':
   meta([['TASK',i.backgroundTaskId],['STATE',r.state??r.status],['PID',r.pid],['STOPPED',r.stopped]]);break;
  case 'background_output':case 'operation_output':
   meta([['ID',i.backgroundTaskId??i.operationId],['STREAM',i.stream],['MORE',r.hasMore]]);
   if(r.output||r.text)content('OUTPUT',r.output??r.text);
   else if(r.results)list('OUTPUT',r.results,x=>(x.path??'')+'  '+String(x.text??'').slice(0,250));break;
  case 'operation_get':
   meta([['OPERATION',i.operationId],['STATE',r.status],['TOOL',r.tool],['STDOUT',r.stdoutBytes],['STDERR',r.stderrBytes]]);break;
  case 'transfer_upload':case 'transfer_download':case 'transfer_status':case 'transfer_cancel':
   meta([['SOURCE',i.sourcePath],['TARGET',i.targetPath],['TRANSFER',i.transferId??r.transferId],['STATE',r.status],['BYTES',r.bytes??r.writtenBytes],['TOTAL',r.totalBytes]]);break;
  case 'system_snapshot':
   meta([['CPU',r.cpuPercent??r.cpu?.usage],['MEMORY',r.memory?.usedBytes],['AVAILABLE',r.memory?.availableBytes]]);
   if(r.disks)list('DISKS',r.disks,x=>(x.mount??x.path??'')+'  '+(x.size??x.total??''));break;
  case 'system_processes':
   list('PROCESSES',r.processes,(x,n)=>(n+1)+'. PID '+(x.pid??'')+'  '+(x.name??'')+'  '+(x.cpu??''));break;
  case 'screen_capture':
   meta([['WIDTH',r.width],['HEIGHT',r.height],['SIZE',r.sizeBytes],['FORMAT',r.format]]);break;
  default:meta([['TARGET',i.path??i.deviceId],['TOOL',a.tool]]);
 }
 return out;
}
export function detailPresentation(a:ActivityEntry,now:number):DetailLine[]{
 const model=activityPresentation(a,now),visual=toolRow(a);
 const i=parse(a.request_json),wrapped=parse(a.result);
 const r=wrapped.data&&typeof wrapped.data==='object'&&!Array.isArray(wrapped.data)?{...wrapped,...wrapped.data}:wrapped;
 return [label('TOOL',visual.toolLabel),label('AGENT',model.agent),
  label('TIME',new Date(a.time).toLocaleString('zh-CN',{hour12:false})),
  label('STATE',model.status,model.state==='failed'?'danger':model.state==='running'?'warning':model.state==='success'?'success':'default'),
  label('DUR',model.elapsed),
  section('ACTION'),line(clean(combined(visual.action),400),'muted'),
  section('RESULT'),line(clean(combined(visual.result),400),visual.result[0]?.tone==='danger'?'danger':'muted'),
  ...contentFor(a,i,r),section('TRACE'),line('ID','default',true),line(clean(a.id,1000),'muted'),
  ...(a.cwd?[line('CWD','default',true),line(clean(a.cwd,1000),'muted')]:[])];
}
const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
function wrapSyntaxLine(item:DetailLine,width:number):DetailLine[]{
 const rows:DetailLine[]=[],max=Math.max(1,width);
 let parts:CodeSpan[]=[],used=0,plain='';
 const flush=()=>{
  rows.push({...item,text:plain,syntax:parts,continued:rows.length>0});
  parts=[];used=0;plain='';
 };
 for(const span of item.syntax??[]){
  for(const {segment} of graphemes.segment(span.text)){
   const cells=cellWidth(segment);
   if(used&&used+cells>max)flush();
   plain+=segment;used+=cells;
   const last=parts.at(-1);
   if(last&&last.color===span.color)last.text+=segment;
   else parts.push({text:segment,color:span.color});
  }
 }
 flush();
 return rows;
}
export function wrapDetail(lines:DetailLine[],width:number):DetailLine[]{
 const w=Math.max(1,width);
 return lines.flatMap(item=>{
  if(item.section){
   // The divider has its own line; the label sits below, in neutral text.
   // The renderer spans the line across the full detail pane, including margins.
   return [{...item,text:'─'.repeat(w+2)},
    {text:item.section,tone:'default',bold:true}];
  }
  if(item.label){
   if(w<12){
    const {label:removed,...plain}=item;
    return wrapLines([item.label+': '+item.text],w).map(v=>({...plain,text:v}));
   }
   const column=Math.min(9,Math.max(5,Math.floor(w*.34)));
   const title=fit(item.label,Math.max(1,column-1));
   const prefix=title+'│ ';
   const available=Math.max(1,w-cellWidth(prefix));
   return wrapLines([item.text],available).map((v,index):DetailLine=>({
    ...item,
    // A continued value keeps the same separator, field/value tones and one-cell side margins.
    text:(index===0?title:' '.repeat(cellWidth(title)))+'│ '+v
   }));
  }
  // Source line numbers are attached before wrapping. Physical terminal wraps
  // get a continuation marker, never a counterfeit source line number.
  const gutter=item.sourceLine!==undefined?(item.lineDigits??String(item.sourceLine??'?').length)+4:0;
  if(item.syntax)return wrapSyntaxLine(item,Math.max(1,w-gutter));
  return wrapLines([item.text],Math.max(1,w-gutter))
   .map((v,index)=>({...item,text:v,continued:index>0}));
 });
}
