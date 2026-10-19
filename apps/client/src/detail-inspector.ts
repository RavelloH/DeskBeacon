import {fullNumberedBlock,type DetailLine} from './detail-presentation.js';
import {languageForCommand,languageForPath} from './syntax-highlight.js';
import type {ActivityEntry} from './presenter.js';

export type InspectorTab='summary'|'input'|'stdout'|'stderr';
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
   rows.push(heading('PROGRAM'));
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
 const metadata={...input};
 if(metadata.command&&typeof metadata.command==='object'&&!Array.isArray(metadata.command)){
  const copied={...(metadata.command as Record<string,unknown>)};
  delete copied.script;
  delete copied.args;
  delete copied.program;
  metadata.command=copied;
 }
 delete metadata.content;
 delete metadata.patch;
 rows.push(heading('PARAMETERS · JSON'));
 rows.push(...fullNumberedBlock(format(metadata),'json'));
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
