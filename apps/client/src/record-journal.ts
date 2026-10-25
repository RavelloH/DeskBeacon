import {createPreview} from '@deskbeacon/protocol';
import {createHash} from 'node:crypto';
import {mkdirSync,openSync,writeSync,readSync,closeSync,statSync,existsSync,fsyncSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {decodeOutputPage,outputEncoding} from './output-encoding.js';
import {normalizeProcessStderr} from './terminal-errors.js';

export type RecordEvent={v:1;type:string;time:number;[key:string]:unknown};
export type RecordPage={text:string;nextOffset:number;totalBytes:number;hasMore:boolean;stream:string;available:boolean;encoding?:string};
type OpenRecord={fd:number;path:string;relativePath:string;operationId:string;bytes:number;stdoutBytes:number;stderrBytes:number;finished:boolean;processExited:boolean;isBackground:boolean};
const sensitive=/token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key/i;
const maxInputBytes=32*1024*1024;
const maxResultBytes=64*1024*1024;
const maxEventLineBytes=70*1024*1024;
const streamChunkBytes=16*1024;

export function safeJournalValue(value:unknown,preserveBinary=false):unknown{
 const seen=new WeakSet<object>();
 const convert=(key:string,v:any):any=>{
  if(key==='env'||(key==='dataBase64'&&!preserveBinary)||sensitive.test(key))return '[redacted]';
  if(typeof v==='bigint')return String(v);
  if(!v||typeof v!=='object')return v;
  if(seen.has(v))return '[circular]';
  seen.add(v);
  if(Array.isArray(v))return v.map(x=>convert('',x));
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,convert(k,x)]));
 };
 return convert('',value);
}
function safeSized(value:unknown,max:number,preserveBinary=false):{value:unknown;limited:boolean}{
 const safe=safeJournalValue(value,preserveBinary);
 const raw=JSON.stringify(safe);
 if(raw===undefined)return{value:null,limited:false};
 if(Buffer.byteLength(raw)<=max)return{value:safe,limited:false};
 return{value:{summary:'Record exceeds local safety budget',originalBytes:Buffer.byteLength(raw),truncated:true},limited:true};
}
export function recordRelativePath(operationId:string,at=Date.now()):string{
 const d=new Date(at),p=(n:number)=>String(n).padStart(2,'0');
 const hash=createHash('sha256').update(operationId).digest('hex');
 return [String(d.getFullYear()),p(d.getMonth()+1),p(d.getDate()),hash+'.jsonl'].join('/');
}
export class RecordJournal{
 private open=new Map<string,OpenRecord>();
 constructor(readonly root:string,private readonly onOutput?:(id:string,stream:'stdout'|'stderr',size:number)=>void){}
 private absolute(relative:string):string{
  if(!/^\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\.jsonl$/.test(relative))throw Error('INVALID_RECORD_PATH');
  const path=resolve(this.root,...relative.split('/'));
  if(!path.startsWith(resolve(this.root)+sep))throw Error('INVALID_RECORD_PATH');
  return path;
 }
 path(relative:string){return this.absolute(relative);}
 exists(relative:string){return existsSync(this.absolute(relative));}
 start(id:string,tool:string,input:unknown,options:{time?:number;parentOperationId?:string;isBackground?:boolean}={}):string{
  if(this.open.has(id))throw Error('RECORD_ALREADY_OPEN');
  const at=options.time??Date.now(),relative=recordRelativePath(id,at),path=this.absolute(relative);
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,'wx',0o600);
  const record:OpenRecord={fd,path,relativePath:relative,operationId:id,bytes:0,stdoutBytes:0,stderrBytes:0,finished:false,processExited:false,isBackground:options.isBackground??false};
  this.open.set(id,record);
  try{
   const prepared=safeSized(input,maxInputBytes);
   this.append(id,{type:'start',operationId:id,tool,parentOperationId:options.parentOperationId??null,input:prepared.value,
    ...(prepared.limited?{inputTruncated:true}:{}),time:at},true);
   fsyncSync(fd); // An accepted side-effecting command must have its journal first.
   return relative;
  }catch(e){this.open.delete(id);closeSync(fd);throw e;}
 }
 private append(id:string,value:Record<string,unknown>,strict=false):void{
  const r=this.open.get(id);if(!r)throw Error('RECORD_NOT_OPEN: '+id);
  const line=Buffer.from(JSON.stringify({v:1,time:Date.now(),...value})+'\n','utf8');
  if(line.length>maxEventLineBytes)throw Error('RECORD_EVENT_TOO_LARGE');
  let written=0;while(written<line.length){const n=writeSync(r.fd,line,written,line.length-written);if(n<=0)throw Error('RECORD_WRITE_FAILED');written+=n;}
  r.bytes+=line.length;
  if(strict)fsyncSync(r.fd);
 }
 stream(id:string,stream:'stdout'|'stderr'|'diff',data:Buffer):void{
  const r=this.open.get(id);if(!r)throw Error('RECORD_NOT_OPEN');
  for(let i=0;i<data.length;i+=streamChunkBytes){
   const chunk=data.subarray(i,i+streamChunkBytes);
   let text:string|undefined;
   try{text=new TextDecoder('utf-8',{fatal:true}).decode(chunk);}catch{}
   this.append(id,text===undefined?
     {type:'stream',stream,encoding:'base64',data:chunk.toString('base64')}:
     {type:'stream',stream,encoding:'utf8',text});
   if(stream==='stdout')r.stdoutBytes+=chunk.length;
   else if(stream==='stderr')r.stderrBytes+=chunk.length;
  }
  if(data.length&&stream!=='diff')this.onOutput?.(id,stream,stream==='stdout'?r.stdoutBytes:r.stderrBytes);
 }
 finish(id:string,result:unknown,status:'completed'|'failed',options:{background?:boolean}={}):void{
  const r=this.open.get(id);if(!r)throw Error('RECORD_NOT_OPEN');
  if(r.finished)throw Error('RECORD_ALREADY_FINISHED');
  const payload:Record<string,unknown>=result&&typeof result==='object'?{...(result as Record<string,unknown>)}:{value:result};
  delete payload.stdout;delete payload.stderr;
  const safe=safeSized(payload,maxResultBytes,true);
  if(safe.limited)throw Error('RECORD_RESULT_LIMIT');
  this.append(id,{type:'result',data:safe.value,...(safe.limited?{resultTruncated:true}:{})});
  this.append(id,{type:'call_finish',status,stdoutBytes:r.stdoutBytes,stderrBytes:r.stderrBytes});
  fsyncSync(r.fd);r.finished=true;
  if(!(options.background??r.isBackground)||r.processExited)this.close(id);
 }
 processExit(id:string,code:number|null):void{
  const r=this.open.get(id);if(!r)return;
  this.append(id,{type:'process_exit',exitCode:code});fsyncSync(r.fd);r.processExited=true;
  if(r.finished)this.close(id);
 }
 close(id:string):void{const r=this.open.get(id);if(!r)return;this.open.delete(id);closeSync(r.fd);}
 closeAll():void{for(const id of [...this.open.keys()])this.close(id);}
 getOpenPath(id:string):string|undefined{return this.open.get(id)?.relativePath;}
 linkChild(parentId:string,childId:string,relativePath:string,tool:string):void{
  this.append(parentId,{type:'child_ref',childId,relativePath,tool});
 }
 getChildren(relative:string):{id:string;path:string;tool:string}[]{
  const rows:{id:string;path:string;tool:string}[]=[];
  for(const e of this.events(relative))if(e.type==='child_ref')
   rows.push({id:String(e.childId),path:String(e.relativePath),tool:String(e.tool)});
  return rows;
 }
 private *events(relative:string):Generator<RecordEvent>{
  const path=this.absolute(relative);if(!existsSync(path))return;
  const fd=openSync(path,'r'),chunk=Buffer.alloc(64*1024);
  let pending=Buffer.alloc(0);
  try{
   for(;;){
    const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;
    pending=Buffer.concat([pending,chunk.subarray(0,n)]);
    if(pending.length>maxEventLineBytes)throw Error('RECORD_EVENT_TOO_LARGE');
    for(;;){
     const end=pending.indexOf(10);if(end<0)break;
     const line=pending.subarray(0,end);pending=pending.subarray(end+1);
     if(!line.length)continue;
     const item=JSON.parse(line.toString('utf8')) as RecordEvent;
     if(item.v!==1||typeof item.type!=='string')throw Error('INVALID_RECORD_EVENT');
     yield item;
    }
   }
   // Intentionally ignore a torn final line after an unexpected process exit.
  }finally{closeSync(fd);}
 }
 getPreview(relative:string):{input:string;result:string}{
  let input:unknown=null,result:unknown=null,tail='',tool='',stdoutChars=0;
  for(const e of this.events(relative)){
   if(e.type==='start'){input=e.input;tool=String(e.tool??'');}
   else if(e.type==='result')result=e.data;
   else if(e.type==='stream'&&e.stream==='stdout'){
    const part=e.encoding==='base64'?new TextDecoder('utf-8').decode(Buffer.from(String(e.data??''),'base64')):String(e.text??'');
    stdoutChars+=part.length;
    tail=(tail+part).slice(-384);
   }
  }
  const preview=(value:unknown,limit:number,kind:'input'|'result')=>{
   const raw=JSON.stringify(value??{});
   if(raw.length<=limit)return raw;
   // Preserve compact file metadata when a JSONL preview exceeds the list limit.
   // Full file content is still available through the on-demand IPC inspector.
   const object=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
   if(tool==='fs_edit'&&kind==='result'){
    const {path,sha256,bytes,replacements,normalizedEol,changed,dryRun,addedLines,removedLines,
      diffStored,diffBytes,diffTruncated}=object;
    return JSON.stringify({path,sha256,bytes,replacements,normalizedEol,changed,dryRun,
      addedLines,removedLines,diffStored,diffBytes,diffTruncated,
      ...(typeof object.diff==='string'?{diff:createPreview(object.diff,2048).text}:{}),
      previewLimited:true});
   }
   if(tool==='fs_edit'&&kind==='input'){
    const {path,mode,expectedHash,dryRun}=object;
    return JSON.stringify({path,mode,expectedHash,dryRun,
      previewInput:createPreview(raw,3072).text,previewLimited:true});
   }
   if(tool==='fs_write'&&kind==='input'){
    const {path,mode,encoding,overwrite,workspaceId}=object;
    return JSON.stringify({path,mode,encoding,overwrite,workspaceId,
      ...(typeof object.content==='string'?{content:createPreview(object.content,3072).text}:{}),
      previewLimited:true});
   }
   if(tool==='fs_read'&&kind==='result'){
    const {path,encoding,readBytes,totalBytes,linesRead,lineOffset,truncated}=object;
    return JSON.stringify({path,encoding,readBytes,totalBytes,linesRead,lineOffset,truncated,
      ...(typeof object.content==='string'?{content:createPreview(object.content,3072).text}:{}),
      previewLimited:true});
   }
   if(tool==='fs_read_many'&&kind==='result'){
    const {successCount,failureCount,bytesUsed,truncated}=object;
    const files=Array.isArray(object.files)?object.files.slice(0,20).map(value=>{
     if(!value||typeof value!=='object')return{};
     const {path,readBytes,lineOffset,error}=value as Record<string,unknown>;
     return {path,readBytes,lineOffset,error};
    }):[];
    return JSON.stringify({successCount,failureCount,bytesUsed,truncated,files,previewLimited:true});
   }
   return JSON.stringify({summary:'预览过长，请查看完整日志',previewLimited:true});
  };
  if(result&&typeof result==='object'&&tail){
   const output=result as Record<string,unknown>;
   output.outputPreview=tail.trim();
   output.outputPreviewKind='tail';
   output.outputPreviewOmittedChars=Math.max(0,stdoutChars-tail.length);
   if(stdoutChars>tail.length)output.previewTruncated=true;
  }
  return{input:preview(input,6000,'input'),result:preview(result,6000,'result')};
 }

 getInput(relative:string):unknown|null{
  for(const e of this.events(relative))if(e.type==='start')return e.input??null;
  return null;
 }
 getResult(relative:string):{status:string;result:any;hasResult:boolean}|null{
  let result:any=null,status='interrupted',hasResult=false;
  const parts:{stdout:Buffer[];stderr:Buffer[]}={stdout:[],stderr:[]};
  let tool='';
  for(const e of this.events(relative)){
   if(e.type==='start')tool=String(e.tool??'');
   else if(e.type==='result'){result=e.data;hasResult=true;}
   else if(e.type==='call_finish')status=String(e.status??'interrupted');
   else if(tool==='exec_foreground'&&e.type==='stream'&&(e.stream==='stdout'||e.stream==='stderr')){
    const b=e.encoding==='base64'?Buffer.from(String(e.data??''),'base64'):Buffer.from(String(e.text??''),'utf8');
    parts[e.stream].push(b);
   }
  }
  if(!hasResult)return null;
  if(result&&typeof result==='object'){
   if(parts.stdout.length)result={...result,stdout:decodeOutputSafe(Buffer.concat(parts.stdout))};
   if(parts.stderr.length)result={...result,stderr:normalizeProcessStderr(decodeOutputSafe(Buffer.concat(parts.stderr)))};
  }
  return{status,result,hasResult};
 }
 getResultRaw(relative:string):string|null{
  const value=this.getResult(relative);return value?JSON.stringify(value.result):null;
 }
 getRecordStream(relative:string,stream:'stdout'|'stderr'|'input'|'result'|'diff',offset:number,budget:number):RecordPage{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(budget)||budget<1||budget>1048576)throw Error('INVALID_RECORD_CURSOR');
  if(!this.exists(relative))return{text:'',nextOffset:0,totalBytes:0,hasMore:false,stream,available:false};
  if(stream==='input'||stream==='result'){
   const value=stream==='input'?this.getInput(relative):this.getResult(relative)?.result;
   if(value===null||value===undefined)return{text:'',nextOffset:0,totalBytes:0,hasMore:false,stream,available:false};
   return bufferPage(Buffer.from(JSON.stringify(value),'utf8'),stream,offset,budget);
  }
  const parts:Buffer[]=[];let total=0,from=offset,selected=0;
  for(const e of this.events(relative)){
   if(e.type!=='stream'||e.stream!==stream)continue;
   const b=e.encoding==='base64'?Buffer.from(String(e.data??''),'base64'):Buffer.from(String(e.text??''),'utf8');
   if(total+b.length>from&&selected<budget+4){
    if(e.encoding==='utf8'&&offset>total&&offset<total+b.length&&b[offset-total]!>=0x80&&b[offset-total]!<=0xbf)throw Error('INVALID_BYTE_OFFSET');
    const start=Math.max(0,from-total),slice=b.subarray(start,start+budget+4-selected);
    parts.push(slice);selected+=slice.length;from=total+b.length;
   }
   total+=b.length;
  }
  if(offset>total)throw Error('INVALID_BYTE_OFFSET');
  const bytes=Buffer.concat(parts),encoding=outputEncoding(bytes),page=decodeOutputPage(bytes,budget,encoding);
  return{text:page.text,nextOffset:offset+page.used,totalBytes:total,hasMore:offset+page.used<total,stream,available:true,encoding};
 }
 getTail(relative:string,stream:'stdout'|'stderr',maxBytes=4096):RecordPage{
  const raw=this.getRecordStream(relative,stream,0,1);
  const start=Math.max(0,raw.totalBytes-maxBytes);
  // A previous stream byte offset can split a scalar; allow a few bytes to resynchronize.
  for(let skip=0;skip<=4;skip++)try{return this.getRecordStream(relative,stream,start+skip,Math.min(65536,maxBytes+8));}catch(e){if(skip===4)throw e;}
  return raw;
 }
}
function decodeOutputSafe(bytes:Buffer):string{return new TextDecoder(outputEncoding(bytes)).decode(bytes);}
function bufferPage(data:Buffer,stream:string,offset:number,budget:number):RecordPage{
 if(offset>data.length||offset>0&&offset<data.length&&data[offset]!>=0x80&&data[offset]!<=0xbf)throw Error('INVALID_BYTE_OFFSET');
 const slice=data.subarray(offset,offset+budget+4),page=decodeOutputPage(slice,budget,'utf-8');
 return{text:page.text,nextOffset:offset+page.used,totalBytes:data.length,hasMore:offset+page.used<data.length,stream,available:true};
}
