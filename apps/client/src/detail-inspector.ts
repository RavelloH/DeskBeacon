import {fullNumberedBlock,type DetailLine} from './detail-presentation.js';
import {languageForCommand,languageForPath} from './syntax-highlight.js';
import type {ActivityEntry} from './presenter.js';

export type InspectorTab='summary'|'input'|'result'|'stdout'|'stderr';
export type FullSource={text:string;totalBytes:number;available:boolean;legacy?:boolean};

const heading=(text:string):DetailLine=>({text,section:text,tone:'muted',bold:true});
const message=(text:string,tone:'muted'|'warning'|'danger'='muted'):DetailLine=>({text,tone});
const format=(value:unknown)=>JSON.stringify(value,null,2)??String(value);
function data(raw:string){
 try{const result=JSON.parse(raw);return result&&typeof result==='object'&&!Array.isArray(result)?result as Record<string,unknown>:null;}
 catch{return null;}
}
export function inspectorInput(entry:ActivityEntry,source:FullSource|null):DetailLine[]{
 if(!source)return [message('正在读取完整输入…')];
 const raw=source.available?source.text:(entry.request_json??'');
 if(!raw)return [message('该操作没有可供显示的输入记录','warning')];
 const input=data(raw);
 const rows:DetailLine[]=[];
 if(entry.record_state==='legacy_partial')rows.push(message('旧版历史存在已截断或缺失的数据，无法恢复为完整记录','warning'));
 if(!source.available){
  rows.push(message('旧版历史没有保存完整输入；下方仅显示仍可用的历史摘要。','warning'));
 }
 if(!input){
  rows.push(heading('INPUT'));
  rows.push(...fullNumberedBlock(raw));
  return rows;
 }
 if('summary' in input&&typeof input.summary==='string')
  rows.push(message('历史输入不完整：'+input.summary,'warning'));
 if(input.content==='[redacted]'||input.dataBase64==='[redacted]')
  rows.push(message('敏感或二进制输入内容未保存在本地快照中','warning'));
 const command=input.command;
 if(command&&typeof command==='object'&&!Array.isArray(command)){
  const c=command as Record<string,unknown>;
  const script=c.mode==='shell'?c.script:undefined;
  if(typeof script==='string'){
   rows.push(heading('COMMAND · '+String(c.shellProfile??'shell')));
   rows.push(...fullNumberedBlock(script,languageForCommand(c)));
  }else if(typeof c.program==='string'){
   rows.push(heading('COMMAND · PROGRAM'));
   rows.push(...fullNumberedBlock(c.program,languageForCommand(c)));
   if(Array.isArray(c.args)&&c.args.length){
    rows.push(heading('ARGUMENTS · JSON'));
    rows.push(...fullNumberedBlock(format(c.args),'json'));
   }
  }
 }
 if(typeof input.content==='string'&&input.content!=='[redacted]'){
  rows.push(heading('FILE CONTENT'));
  rows.push(...fullNumberedBlock(input.content,languageForPath(input.path),
    input.mode==='append'?null:1));
 }
 if(typeof input.patch==='string'){
  rows.push(heading('PATCH'));
  rows.push(...fullNumberedBlock(input.patch,'diff'));
 }
 // The inspector must show the exact entire locally stored request:
 // command.script, program, args, cwd, env (redacted at persistence), file
 // content and patch all belong to the input. The standalone code sections
 // above are just convenient syntax-highlighted views, not replacements.
 rows.push(heading('COMPLETE INPUT · JSON'));
 rows.push(...fullNumberedBlock(format(input),'json'));
 return rows;
}
/** Show the complete structured tool result from local receipts, not the
 * activity list's truncated/redacted preview. */
export function inspectorResult(entry:ActivityEntry,source:FullSource|null):DetailLine[]{
 if(!source)return [message('正在读取完整结果…')];
 const raw=source.available?source.text:(entry.result??'');
 if(!raw)return [message('此操作没有保存可读取的结果','warning')];
 const rows:DetailLine[]=[];
 if(entry.record_state==='legacy_partial')rows.push(message('该记录由旧版本迁移，部分原始内容可能已丢失','warning'));
 if(!source.available)rows.push(message('历史完整回执已缺失；以下仅为摘要缓存，无法恢复被删减的数据。','warning'));
 if(entry.tool==='fs_edit'&&/^(?:Index:|={20,}|--- )/.test(raw)){
  rows.push(heading('DIFF · OUTPUT'));
  rows.push(...fullNumberedBlock(raw,'diff'));
  return rows;
 }
 const result=data(raw);
 if(result){
  const payload=result.data&&typeof result.data==='object'&&!Array.isArray(result.data)?
   result.data as Record<string,unknown>:result;
  if(entry.tool==='fs_read'&&typeof payload.content==='string'){
   const request=data(entry.request_json??'')??{};
   const rawOffset=payload.lineOffset??request.lineOffset;
   const start=Number.isSafeInteger(rawOffset)?Number(rawOffset)+1:
     Number(request.byteOffset??0)>0?null:1;
   rows.push(heading('FILE CONTENT'));
   rows.push(...fullNumberedBlock(payload.content,languageForPath(request.path),start));
  }
  if(entry.tool==='fs_read_many'&&Array.isArray(payload.files)){
   for(const file of payload.files){
    if(!file||typeof file!=='object')continue;
    const item=file as Record<string,unknown>;
    if(typeof item.content!=='string')continue;
    rows.push(heading('FILE · '+String(item.path??'unknown')));
    rows.push(...fullNumberedBlock(item.content,languageForPath(item.path),
      Number.isSafeInteger(item.lineOffset)?Number(item.lineOffset)+1:1));
   }
  }
  rows.push(heading('COMPLETE RESULT · JSON'));
  rows.push(...fullNumberedBlock(format(result),'json'));
 }else{
  rows.push(heading('RESULT'));
  rows.push(...fullNumberedBlock(raw));
 }
 return rows;
}
export function inspectorOutput(source:FullSource|null,stream:'stdout'|'stderr',language?:string,sourceLimited=false):DetailLine[]{
 if(!source)return [message('正在读取完整 '+stream+'…')];
 const rows:DetailLine[]=[];
 if(sourceLimited)rows.push(message('执行器已达到输出上限，源日志后续缺失字符数无法确定','warning'));
 if(!source.available)return [message('本机没有保存 '+stream+' 输出','warning'),...rows];
 if(!source.text)return [message('（空输出）')];
 // JSON and structured text are highlighted, ordinary stdout stays neutral.
 const json=source.text.trimStart();
 let resolvedLanguage=language;
 if(!resolvedLanguage&&(json.startsWith('{')||json.startsWith('['))){
  try{JSON.parse(json);resolvedLanguage='json';}catch{}
 }
 rows.push(...fullNumberedBlock(source.text,resolvedLanguage));
 return rows;
}
export function storedOutputLimited(entry:ActivityEntry):boolean{
 try{
  const result=JSON.parse(entry.result??'{}');
  return result.outputLimit===true||result.data?.outputLimit===true;
 }catch{return false;}
}
export function inspectorCopyText(tab:InspectorTab,entry:ActivityEntry|undefined,source:FullSource|null,summary=''):string{
 if(tab==='summary')return summary;
 if(tab==='input')return source?.available?source.text:entry?.request_json??'';
 return source?.text??'';
}
