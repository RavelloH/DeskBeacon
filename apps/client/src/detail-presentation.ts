import {createPreview,splitOutputPreview,type OutputPreview} from '@deskbeacon/protocol';
import {createDetailSections,type DetailBlock,type PreviewEdgeOmission,type PreviewPreference} from './detail-preview.js';
import {activityPresentation,type ActivityEntry} from './presenter.js';
import {toolRow,type Tone,type Segment} from './tool-presentation.js';
import {cellWidth,fit,wrapLines} from './tui-layout.js';
import {highlightCodeLines,languageForPath,languageForCommand,type CodeSpan} from './syntax-highlight.js';
import {normalizeProcessStderr} from './terminal-errors.js';
import {styleTerminalSource,detectOutputLanguage,type StyledSource} from './terminal-highlight.js';

export type DetailLine={text:string;tone?:Tone;bold?:boolean;italic?:boolean;label?:string;section?:string;syntax?:CodeSpan[]|undefined;
 sourceLine?:number|null;continued?:boolean;lineDigits?:number;gutterLabel?:string};
type Fields=Record<string,any>;
const line=(text:string,tone:Tone='default',bold=false,italic=false):DetailLine=>({text,tone,bold,italic});
const label=(key:string,value:unknown,tone:Tone='default'):DetailLine=>({text:clean(String(value??'—'),1000),label:key,tone});
const section=(title:string):DetailLine=>({text:title,section:title,tone:'muted',bold:true});
/** Same source-line gutter string for layout width measurement and Ink rendering. */
export function sourceLineGutter(item:Pick<DetailLine,'sourceLine'|'gutterLabel'|'lineDigits'|'continued'>):string{
 if(item.sourceLine===undefined)return '';
 const label=item.gutterLabel??String(item.sourceLine??'?');
 const digits=Math.max(item.lineDigits??0,cellWidth(label));
 return ' '+(item.continued?' '.repeat(digits):label.padStart(digits))+' │ ';
}
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
 return scrubbed.length>max?scrubbed.slice(0,max)+' … [已省略 '+(scrubbed.length-max)+' 字符]':scrubbed;
}
/** Full inspector blocks do not impose the summary's 280-line/64K-character cap. */
export function fullNumberedBlock(raw:unknown,language?:string,startLine:number|null=1):DetailLine[]{
 return numberedBlock(raw,language,startLine,Infinity,Infinity);
}
export function numberedBlock(raw:unknown,language?:string,startLine:number|null=1,
 maxLines=280,maxChars=64000,expand:'i'|'o'='o'):DetailLine[]{
 if(typeof raw!=='string')return [line('（内容不可用）','muted',false,true)];
 // Highlight the WHOLE logical source first, then select visible lines.
 // This preserves multi-line lexical state and original ANSI colors.
 const rendered=styleTerminalSource(raw,language??detectOutputLanguage(raw));
 const whole=rendered.lines.join('\n');
 const budget=maxLines===Infinity&&maxChars===Infinity?Infinity:Math.max(64,Math.min(maxChars,4096));
 if(Number.isFinite(budget)){
  const preview=createPreview(whole,budget);
  return numberedPreviewBlock(preview,language,startLine,undefined,raw,expand,rendered);
 }
 const digitCount=startLine===null?1:String(startLine+Math.max(0,rendered.lines.length-1)).length;
 return rendered.lines.map((value,index)=>({
  ...line(value,'muted'),syntax:rendered.spans[index],
  sourceLine:startLine===null||index===rendered.lines.length-1&&value==='' ?null:startLine+index,lineDigits:digitCount
 }));
}
/** Redact credential-like values in source excerpts without stripping ANSI colors. */
function maskSourceSecrets(raw:string):string{
 return raw
  .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi,'$1 [redacted]')
  .replace(/\b(password|passwd|authorization|secret|token|api[_-]?key|private[_-]?key|dataBase64)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]')
  .replace(/\b(sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,})\b/gi,'[redacted]');
}
const loc=(x:Fields)=>x.path??x.name??x.sourcePath??x.filename??'';
const cmd=(x:Fields)=>{const c=x.command;if(!c||typeof c!=='object')return '';return c.mode==='shell'?String(c.script??''):[c.program,...(Array.isArray(c.args)?c.args:[])].join(' ');};

function compactField(raw:string,max:number,expand:'i'|'o'='o'):string{
 const value=clean(raw,Infinity).replace(/\s+/g,' ');
 if(value.length<=max)return value;
 return value.slice(0,max)+' [已隐藏 '+(value.length-max)+' 字符 · 按 '+expand+
  ' 查看完整'+(expand==='i'?'输入':'输出')+']';
}
function batchLines(input:Fields,result:Fields,running:boolean,resultLimited=false):DetailLine[]{
 const lines:DetailLine[]=[];
 const requests=Array.isArray(input.stages)?input.stages:[];
 const responses=Array.isArray(result.stages)?result.stages:[];
 if(!requests.length&&!responses.length){
  lines.push(line('[历史摘要未包含子操作 · 按 i 查看完整输入 / 按 o 查看完整结果]','warning'));
  return lines;
 }
 const count=Math.max(requests.length,responses.length);
 for(let stageIndex=0;stageIndex<count;stageIndex++){
  const stage=requests[stageIndex]??{},response=responses[stageIndex]??{};
  const calls=Array.isArray(stage.calls)?stage.calls:[];
  const results=Array.isArray(response.results)?response.results:[];
  const items=calls.length?calls:results;
  const parallel=stage.parallel??response.parallel;
  lines.push(section('STAGE '+(stageIndex+1)+' · '+(parallel?'并行':'串行')+' · '+items.length+' 项'));
  for(const [index,call] of items.entries()){
   const received=results.find((item:Fields)=>item.id!==undefined&&item.id===call.id)??results[index];
   const params=call.input??{},tool=String(call.tool??received?.tool??'unknown');
   const data=received?.result?.data&&typeof received.result.data==='object'
    ?received.result.data:received?.result??{};
   const error=received?.error??{};
   const state=received===undefined?(running?'等待执行':result.stoppedEarly?'已跳过':'未记录结果'):
    received.ok===false?'失败':'成功';
   const tone:Tone=received?.ok===false?'danger':received?.ok===true?'success':'muted';
   lines.push(line((index+1)+'. '+clean(tool,60)+' · '+clean(call.id??received?.id??'',90)+'  '+state,tone,true));
   if(params.description)lines.push(label('INTENT',compactField(String(params.description),160,'i')));
   if(params.command){
    const command=cmd(params);
    lines.push(label('COMMAND',compactField(command,240,'i')));
    if(params.command.cwd)lines.push(label('CWD',clean(String(params.command.cwd),180)));
   }
   const target=params.path??params.sourcePath??params.targetPath??params.url??params.archivePath??
    (Array.isArray(params.paths)?params.paths.join(', '):undefined);
   if(target)lines.push(label('TARGET',clean(String(target),180)));
   const operation=[params.action,params.mode,params.method,params.pattern].filter(Boolean).join(' · ');
   if(operation)lines.push(label('OPTIONS',clean(operation,160)));
   if(received){
    const fields=[
     data.exitCode!==undefined?'退出码 '+data.exitCode:'',
     data.status??'',
     data.readBytes!==undefined?'读取 '+data.readBytes+' B':'',
     data.writtenBytes!==undefined?'写入 '+data.writtenBytes+' B':'',
     data.timedOut?'超时':'',data.cancelled?'已取消':'',
     received.truncated?'返回内容不完整':'',
     Number.isFinite(received.durationMs)?received.durationMs+' ms':''
    ].filter(Boolean).join(' · ');
    if(fields)lines.push(label('RESULT',fields));
    if(error.code||error.message)lines.push(label('ERROR',compactField([error.code,error.message].filter(Boolean).join(' · '),240,'o'),'danger'));
    if(data.errorSummary)lines.push(label('ERROR',compactField(String(data.errorSummary),220,'o'),'danger'));
    if(!resultLimited){
     for(const [name,value] of [['STDOUT',data.stdout??data.outputPreview],['STDERR',data.stderr]] as const)
      if(typeof value==='string'&&value.length)
       lines.push(label(name,compactField(value,160,'o'),name==='STDERR'?'warning':'muted'));
    }
    if(!resultLimited&&(data.stdoutTruncated||data.stderrTruncated))
     lines.push(line('[子操作输出不完整 · 按 o 查看已保存结果]','warning'));
   }
  }
 }
 return lines;
}

// Slicing a preview must NOT cause a second independent syntax-highlight pass.
// For original data still available, select pre-highlighted spans by the
// original logical line positions (including continuous multiline syntax).
function selectedSpans(
 source:StyledSource|undefined,index:number,visible:string,side:'head'|'tail'
):CodeSpan[]|undefined{
 if(!source||index<0||index>=source.lines.length)return undefined;
 const whole=source.lines[index]??'';
 if(!whole)return [];
 const spans=source.spans[index]??[];
 const total=whole.length;
 const length=visible.length;
 if(whole===visible)return spans;
 const start=side==='tail'?Math.max(0,total-length):0;
 const end=Math.min(total,start+length);
 let cursor=0;
 const result:CodeSpan[]=[];
 for(const span of spans){
  const from=Math.max(start,cursor),to=Math.min(end,cursor+span.text.length);
  if(from<to)result.push({text:span.text.slice(from-cursor,to-cursor),color:span.color});
  cursor+=span.text.length;
 }
 return result.map(s=>s);
}
export function numberedPreviewBlock(preview:OutputPreview,language?:string,startLine:number|null=1,
 lineMap?:Array<number|null>,originalSource?:string,expand:'i'|'o'='o',
 sourceStyled?:StyledSource,edgeOmission?:PreviewEdgeOmission):DetailLine[]{
 const split=splitOutputPreview(preview);
 const rendered=sourceStyled??(originalSource===undefined?undefined:
  styleTerminalSource(originalSource,language??detectOutputLanguage(originalSource)));
 const fromRows=(text:string,start:number|null,rawOffset:number,side:'head'|'tail')=>{
  if(!text)return [];
  const normalized=styleTerminalSource(text,language??detectOutputLanguage(text));
  const rows=text.endsWith('\n')?normalized.lines.slice(0,-1):normalized.lines;
  const maxLogical=Math.max((start??1)+(rendered?.lines.length??rows.length)-1,
   (startLine??1)+(preview.totalLines??0)-1,start??0);
  const digits=String(Math.max(1,maxLogical)).length;
  const mapped:DetailLine[]=[];
  for(let index=0;index<rows.length;index++){
   const text=rows[index]??'';
   const sourceIndex=lineMap?rawOffset+index:
    start===null?-1:start-startLine!+index;
   const lexical=selectedSpans(rendered,sourceIndex,text,side);
   const spans=lexical??normalized.spans[index];
   const diffTone:Tone=language==='diff'&&text.startsWith('+')&&!text.startsWith('+++')?'success':
    language==='diff'&&text.startsWith('-')&&!text.startsWith('---')?'danger':'muted';
   const row:DetailLine={...line(text,diffTone),syntax:diffTone==='muted'?spans:undefined,lineDigits:digits};
   const n=lineMap?.[rawOffset+index]??(start===null?null:start+index);
   if(typeof n==='number')row.sourceLine=n;
   else if(start===null||lineMap)delete row.lineDigits;
   mapped.push(row);
  }
  return mapped;
 };
 const edgeRow=():DetailLine=>line('…','muted');
 const hiddenLines=preview.omittedLines??(
  preview.totalLines!==undefined&&preview.headLines!==undefined&&preview.tailStartLine!==undefined
   ?Math.max(0,preview.tailStartLine-preview.headLines-1):undefined
 );
 const hiddenAmount=hiddenLines!==undefined&&hiddenLines>0
  ?hiddenLines+' 行':preview.omittedBytes>0?preview.omittedBytes+' 字节':'内容';
 const subject=expand==='i'?'输入':'输出';
 const notice=preview.hasFullOutput
  ?'已隐藏 '+hiddenAmount+' · 按 '+expand+' 查看完整'+subject
  :'已隐藏 '+hiddenAmount+' · 原始'+subject+'不完整 · 按 '+expand+' 查看已保存内容';
 if(!split){
  const rows=fromRows(preview.text,startLine,0,'head');
  // Retain a terminal newline in complete source without inventing a numbered line.
  if(!preview.truncated&&preview.text.endsWith('\n'))rows.push({...line('','muted'),syntax:[]});
  if(edgeOmission){
   return edgeOmission.direction==='head'?[edgeRow(),...rows]:[...rows,edgeRow()];
  }
  if(preview.truncated){
   const fallback=preview.hasFullOutput
    ?'[预览已截断 · 按 '+expand+' 查看完整'+subject+']'
    :'[原始'+subject+'不完整 · 按 '+expand+' 查看已保存内容]';
   return [...rows,line(fallback,'warning')];
  }
  if(!preview.hasFullOutput)
   return [...rows,line('[原始'+subject+'不完整 · 按 '+expand+' 查看已保存内容]','warning')];
  return rows;
 }
 const head=split.head,tail=split.tail;
 const tailStart=startLine!==null&&preview.tailStartLine!==undefined
  ?startLine+preview.tailStartLine-1:null;
 const tailOffset=preview.tailStartLine===undefined?0:preview.tailStartLine-1;
 let result:DetailLine[];
 if(split.direction==='middle'){
  const omission:DetailLine={
   ...line('['+notice+']','muted'),
   sourceLine:null,gutterLabel:'...',
   lineDigits:Math.max(3,String(Math.max(1,preview.totalLines??1)).length)
  };
  result=[
   ...fromRows(head,startLine,0,'head'),
   omission,
   ...fromRows(tail,tailStart,tailOffset,'tail')
  ];
  const digits=Math.max(3,...result.map(row=>row.lineDigits??0));
  for(const row of result)if(row.sourceLine!==undefined)row.lineDigits=digits;
 }else if(split.direction==='head'){
  result=[edgeRow(),...fromRows(tail,tailStart,tailOffset,'tail')];
 }else{
  result=[...fromRows(head,startLine,0,'head'),edgeRow()];
 }
 if(edgeOmission&&edgeOmission.direction!==split.direction){
  if(edgeOmission.direction==='head')result.unshift(edgeRow());
  else result.push(edgeRow());
 }
 if(!preview.hasFullOutput&&split.direction!=='middle')
  result.unshift(line('[原始'+subject+'不完整 · 按 '+expand+' 查看已保存内容]','warning'));
 return result;
}

function contentFor(a:ActivityEntry,i:Fields,r:Fields,liveLog="",liveLogPreview?:OutputPreview):DetailLine[]{
 const out:DetailLine[]=[],blocks:DetailBlock[]=[];
 let batchSummary:DetailLine[]|null=null;
 const meta=(fields:[string,unknown][])=>out.push(...fields.filter(([,v])=>v!==undefined&&v!==null&&v!=='')
  .map(([k,v])=>label(k,v)));
 const content=(title:string,value:unknown,kind:'input'|'output'='output',
  preference:PreviewPreference='balanced',language?:string,startLine:number|null=1,
  sourcePreview?:OutputPreview,edgeOmission?:PreviewEdgeOmission)=>{
  if(typeof value==='string'&&value&&value!=='[redacted]'){
   const safe=maskSourceSecrets(value);
   // Source offsets become invalid if redaction changes the excerpt length.
   const safePreview=safe===value?sourcePreview:undefined;
   blocks.push({kind,title,text:safe,preference,startLine,
    ...(safePreview?{sourcePreview:safePreview}:{}),...(language?{language}:{}),
    ...(edgeOmission?{edgeOmission}:{})});
  }
 };
 const list=(title:string,value:unknown,format:(v:Fields,n:number)=>string)=>{
  if(!Array.isArray(value))return;
  content(title,value.map((item,n)=>{try{return format(item,n);}catch{return String(n+1)+'. 记录';}})
   .join('\n'),'output','head');
 };
 switch(a.tool){
  case 'fs_edit':
   meta([['PATH',i.path],['MODE',i.mode],['MATCHES',r.replacements],
    ['SHA256',r.sha256],['DRY RUN',r.dryRun],['DIFF BYTES',r.diffBytes]]);
   // This is the actual applied before/after diff saved in the result journal.
   // Do not synthesize a counterfeit diff from oldText/newText snippets.
   const editInput=typeof i.previewInput==='string'?i.previewInput:
    i.mode==='patch'?i.patch:
    i.mode==='replace'?JSON.stringify({oldText:i.oldText,newText:i.newText,
     expectedReplacements:i.expectedReplacements},null,2):
    i.mode==='replace_many'?JSON.stringify(i.replacements??[],null,2):'';
   content('EDIT PARAMETERS',editInput,'input','balanced',i.mode==='patch'?'diff':'json',
    1,i.previewInputMeta?{...i.previewInputMeta,text:i.previewInput}:undefined);
   if(typeof r.diff==='string')content('DIFF',r.diff,'output','balanced','diff',1,
     r.diffPreviewMeta?{...r.diffPreviewMeta,text:r.diff}:undefined);
   // An unchanged edit has no diff; old receipts without a diff remain silent.
   break;
  case 'fs_write':
   meta([['PATH',i.path],['MODE',i.mode],['BYTES',r.writtenBytes],['SHA256',r.sha256]]);
   if(i.encoding==='base64')out.push(line('二进制/Base64 输入不作为源码显示','muted'));
   else {
    content(i.mode==='append'?'APPENDED CONTENT':'FILE CONTENT',i.content,
     'input','balanced',languageForPath(i.path),1,
     i.contentPreviewMeta?{...i.contentPreviewMeta,text:i.content}:undefined);
    if((typeof i.content!=='string'||i.content==='[redacted]')&&!i.previewLimited)
     out.push(line('未保存可预览的写入文本','muted'));
   }
   if(i.previewLimited&&!blocks.length)out.push(line('[历史输入摘要已压缩 · 按 i 查看完整输入]','warning'));
   break;
  case 'fs_read':
   meta([['PATH',i.path],['LINES',r.linesRead],['BYTES',r.readBytes],['MORE',r.truncated]]);
   const offset=r.lineOffset??i.lineOffset;
   const start=Number.isSafeInteger(offset)?Number(offset)+1:
     Number(i.byteOffset??0)>0?null:1;
   content('FILE CONTENT',r.content,'output','balanced',languageForPath(i.path),start,
    r.contentPreviewMeta?{...r.contentPreviewMeta,text:r.content}:undefined);
   if(r.previewLimited&&!blocks.length)out.push(line('[历史结果摘要已压缩 · 按 o 查看完整结果]','warning'));
   else if((typeof r.content!=='string'||r.content==='[redacted]')&&!r.previewLimited)
    out.push(line('未保存此次读取的正文','muted'));
   break;
  case 'fs_read_many':
   meta([['SUCCESS',r.successCount],['FAILED',r.failureCount],['BYTES',r.bytesUsed]]);
   for(const file of (Array.isArray(r.files)?r.files:[])){
    const path=String(loc(file));
    if(file.error)content('FILE · '+path,String(file.error),'output','head');
    else content('FILE · '+path,file.content,'output','balanced',languageForPath(path),
      Number.isSafeInteger(file.lineOffset)?Number(file.lineOffset)+1:
      Number(i.files?.find((f:Fields)=>f.path===file.path)?.byteOffset??0)>0?null:
      Number(i.files?.find((f:Fields)=>f.path===file.path)?.lineOffset??0)+1,
      file.contentPreviewMeta?{...file.contentPreviewMeta,text:file.content}:undefined);
   }
   if(r.previewLimited&&!blocks.length)out.push(line('[历史结果摘要已压缩 · 按 o 查看完整结果]','warning'));
   break;
  case 'fs_grep':
   meta([['PATTERN',i.pattern],['PATH',i.path],['MATCHES',r.totalMatches??r.matches?.length],['MORE',r.truncated]]);
   list('MATCHES',r.matches,(x,n)=>(n+1)+'. '+loc(x)+':'+(x.lineNumber??x.line??'?')+'  '+(x.text??x.content??x.lineText??''));break;
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
   list('ENTRIES',r.entries,(x,n)=>(n+1)+'. '+loc(x)+'  '+(x.size??''));break;
  case 'exec_foreground':case 'exec_background':
   meta([['CWD',i.command?.cwd??a.cwd],['EXIT',r.exitCode],['PID',r.pid],['TIMEOUT',r.timedOut]]);
   content('COMMAND',cmd(i),'input','balanced',languageForCommand(i.command));
   const stdoutPreview=liveLog?liveLogPreview:
    !liveLog&&r.outputPreviewKind==='head_tail'&&r.outputPreviewMeta?
     {...r.outputPreviewMeta,text:r.outputPreview}:undefined;
   const legacyTail=!liveLog&&r.outputPreviewKind==='tail'&&r.outputPreviewOmittedChars>0
    ?{direction:'head' as const,omittedCount:Number(r.outputPreviewOmittedChars),unit:'characters' as const,fullSourceAvailable:true}
    :undefined;
   content(liveLog?'LIVE STDOUT':'STDOUT',liveLog||r.stdout||r.outputPreview,'output','tail',undefined,
    !liveLog&&typeof r.stdout==='string'||r.outputPreviewKind==='head_tail'?1:null,
    stdoutPreview,legacyTail);
   content('STDERR',r.stderr??'','output','tail');
   break;
  case 'batch':
   meta([['STAGES',i.stages?.length],['DONE',r.completed],['FAILED',r.failed],['SKIPPED',r.skipped]]);
   if(i.previewLimited)out.push(line('[历史输入摘要已压缩 · 按 i 查看完整输入]','warning'));
   else content('BATCH REQUEST',JSON.stringify(i,null,2),'input','balanced','json');
   batchSummary=batchLines(i,r,a.status==='running'||a.status==='queued',Boolean(r.previewLimited));
   if(r.previewLimited)out.push(line('[历史结果摘要已压缩 · 按 o 查看完整结果]','warning'));
   break;
  case 'http_request':
   meta([['METHOD',i.method],['URL',i.url],['HTTP',r.status??r.statusCode],['BYTES',r.bytes??r.readBytes]]);
   content('REQUEST BODY',i.body??i.text,'input','balanced');
   content('RESPONSE',r.text??r.outputPreview,'output','balanced');break;
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
   content('OUTPUT',r.output??r.text,'output','tail');
   if(!blocks.length&&Array.isArray(r.results))content('OUTPUT',r.results.map((x:Fields)=>String(x.text??'')).join('\n'),'output','tail');
   break;
  case 'operation_get':
   meta([['OPERATION',i.operationId],['STATE',r.status],['TOOL',r.tool],['STDOUT',r.stdoutBytes],['STDERR',r.stderrBytes]]);break;
  case 'transfer_upload':case 'transfer_download':case 'transfer_status':case 'transfer_cancel':
   meta([['SOURCE',i.sourcePath],['TARGET',i.targetPath],['TRANSFER',i.transferId??r.transferId],['STATE',r.status],['BYTES',r.bytes??r.writtenBytes],['TOTAL',r.totalBytes]]);break;
  case 'system_snapshot':
   meta([['CPU',r.cpuPercent??r.cpu?.usage],['MEMORY',r.memory?.usedBytes],['AVAILABLE',r.memory?.availableBytes]]);
   list('DISKS',r.disks,(x,n)=>(n+1)+'. '+(x.mount??x.path??'')+'  '+(x.size??x.total??''));break;
  case 'system_processes':
   list('PROCESSES',r.processes,(x,n)=>(n+1)+'. PID '+(x.pid??'')+'  '+(x.name??'')+'  '+(x.cpu??''));break;
  case 'screen_capture':
   meta([['WIDTH',r.width],['HEIGHT',r.height],['SIZE',r.sizeBytes],['FORMAT',r.format]]);break;
  default:meta([['TARGET',i.path??i.deviceId],['TOOL',a.tool]]);
 }
 for(const group of createDetailSections(blocks)){
  out.push(section(group.kind==='input'?'INPUT':'OUTPUT'));
  for(const part of group.parts){
   if(part.title)out.push(section(part.title));
   const sourceStart=part.startLine===undefined?null:part.startLine;
   out.push(...numberedPreviewBlock(part.preview,part.language,sourceStart,undefined,part.sourceText,
    group.kind==='input'?'i':'o',undefined,part.edgeOmission));
  }
 }
 if(batchSummary?.length){
  out.push(section('OUTPUT'));
  out.push(...batchSummary);
 }
 return out;
}
export function detailPresentation(a:ActivityEntry,now:number,liveLog="",liveLogPreview?:OutputPreview):DetailLine[]{
 const model=activityPresentation(a,now),visual=toolRow(a);
 const i=parse(a.request_json),wrapped=parse(a.result);
 const r=wrapped.data&&typeof wrapped.data==='object'&&!Array.isArray(wrapped.data)?{...wrapped,...wrapped.data}:wrapped;
 return [label('TOOL',visual.toolLabel),label('AGENT',model.agent),
  label('TIME',new Date(a.time).toLocaleString('zh-CN',{hour12:false})),
  label('STATE',model.status,model.state==='failed'?'danger':model.state==='running'?'warning':model.state==='success'?'success':'default'),
  label('DUR',model.elapsed),
  section('ACTION'),line(clean(combined(visual.action),400),'muted'),
  section('RESULT'),line(clean(combined(visual.result),400),visual.result[0]?.tone==='danger'?'danger':'muted'),
  ...contentFor(a,i,r,liveLog,liveLogPreview),section('TRACE'),line('ID','default',true),line(clean(a.id,1000),'muted'),
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
  const gutter=cellWidth(sourceLineGutter(item));
  if(item.syntax)return wrapSyntaxLine(item,Math.max(1,w-gutter));
  return wrapLines([item.text],Math.max(1,w-gutter))
   .map((v,index)=>({...item,text:v,continued:index>0}));
 });
}
