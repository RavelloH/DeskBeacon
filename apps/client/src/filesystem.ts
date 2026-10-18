import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';
import { applyPatch } from 'diff';
import AdmZip from 'adm-zip';
import * as tar from 'tar';

type Input=Record<string,any>;
const utf8=(s:string)=>Buffer.from(s,'utf8');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function fileHash(path:string){
 const digest=createHash('sha256');
 for await(const chunk of createReadStream(path))digest.update(chunk as Buffer);
 return digest.digest('hex');
}
async function atomicWrite(path:string,data:Buffer,overwrite=true){
 const temp=path+'.deskbeacon-'+crypto.randomUUID()+'.tmp';
 await fs.mkdir(dirname(path),{recursive:true});
 try{
   await fs.writeFile(temp,data,{flag:'wx'});
   if(!overwrite)try{await fs.stat(path);throw Error('FILE_EXISTS');}catch(e:any){if(e.code!=='ENOENT')throw e;}
   await fs.rename(temp,path);
 }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}
function location(p:string,root?:string){return isAbsolute(p)?resolve(p):resolve(root??process.cwd(),p);}
async function statOne(path:string,includeHash=false){
 const s=await fs.lstat(path);return {path,kind:s.isFile()?'file':s.isDirectory()?'directory':s.isSymbolicLink()?'symlink':'other',
 size:s.size,createdAt:s.birthtime.toISOString(),modifiedAt:s.mtime.toISOString(),
 ...(includeHash&&s.isFile()?{sha256:await fileHash(path)}:{})};
}
async function search(name:string,input:Input,path:string){
 const args:string[]=[];
 if(name==='fs_find'){
   args.push('--files');
   if(input.pattern){
     const literal=String(input.pattern).replace(/[?*\[\]{}\\]/g, '\\$&');
     args.push('-g','*'+literal+'*');
   }
 }
 else args.push('--json','--line-number','--color','never',...(input.literal?['--fixed-strings']:[]),...(input.caseSensitive?[]:['--ignore-case']),
 '-C',String(input.contextLines??0),'-e',input.pattern);
 if(input.includeHidden)args.push('--hidden');
 if(input.respectIgnore===false)args.push('--no-ignore');
 for(const g of input.glob??[])args.push('-g',g);
 args.push('--',path);
 return await new Promise<any>((accept,reject)=>{
   const child=spawn(rgPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='',exceeded=false;
   const max=Math.min(input.maxBytes??2*1024*1024,8*1024*1024);
   const timer=setTimeout(()=>{exceeded=true;child.kill();},input.timeoutMs??30000);
   child.stdout.on('data',(b:Buffer)=>{stdout+=b.toString('utf8');if(Buffer.byteLength(stdout)>max){exceeded=true;child.kill();}});
   child.stderr.on('data',(b:Buffer)=>{stderr+=b.toString('utf8').slice(0,4000);});
   child.on('error',reject);
   child.on('close',code=>{
     clearTimeout(timer);
     if(code!==0&&code!==1&&!exceeded)return reject(Error('RIPGREP_FAILED '+stderr));
     if(name==='fs_find'){
       const found=stdout.split(/\r?\n/).filter(Boolean);
       return accept({paths:found.slice(0,input.maxResults??1000),truncated:exceeded||found.length>(input.maxResults??1000),
         searchedRoot:path});
     }
     const matches:any[]=[];
     for(const line of stdout.split(/\r?\n/)){
       if(!line.trim())continue;
       let event:any;try{event=JSON.parse(line);}catch{continue;}
       if(event.type!=='match')continue;
       const data=event.data;
       matches.push({path:data.path?.text??null,line:data.line_number,column:data.submatches?.[0]?.start??null,
         text:data.lines?.text??'',submatches:data.submatches});
       if(matches.length>=input.maxResults)break;
     }
     accept({matches,truncated:exceeded||matches.length>=(input.maxResults??500),searchedRoot:path,stderr:stderr||undefined});
   });
 });
}
function safeArchiveEntry(root:string,name:string){
 if(!name||name.includes('\0')||name.startsWith('/')||name.startsWith('\\')||/^[a-zA-Z]:/.test(name))throw Error('UNSAFE_ARCHIVE_ENTRY');
 const normalized=name.replace(/\\/g,'/');
 const pieces=normalized.split('/');
 if(pieces.some(x=>x==='..'))throw Error('UNSAFE_ARCHIVE_ENTRY');
 const target=resolve(root,...pieces);const rel=relative(resolve(root),target);
 if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('UNSAFE_ARCHIVE_ENTRY');
 return target;
}
async function archive(i:Input) {
 if(i.action==='create'){
   const dest=location(i.outputPath);const paths:(string[])=(i.sourcePaths??[]).map((p:string)=>location(p));
   if(i.format==='zip'){
     const zip=new AdmZip();
     for(const p of paths){const s=await fs.lstat(p);if(s.isSymbolicLink())throw Error('SYMLINK_ARCHIVE_UNSUPPORTED');
       if(s.isDirectory())zip.addLocalFolder(p,basename(p));else zip.addLocalFile(p);}
     const data=zip.toBuffer();
     if(data.length>i.maxBytes)throw Error('ARCHIVE_TOO_LARGE');
     await atomicWrite(dest,data,i.overwrite);return{path:dest,bytes:data.length,sha256:hash(data)};
   }
   // tar creates a stream to target file; only known-safe relative path names.
   const archiveRoot=dirname(paths[0]??dest);
   if(paths.some(p=>relative(archiveRoot,p).startsWith('..')))throw Error('ARCHIVE_REQUIRES_COMMON_PARENT');
   await fs.mkdir(dirname(dest),{recursive:true});
   if(!i.overwrite)await fs.stat(dest).then(()=>{throw Error('FILE_EXISTS');}).catch(e=>{if(e.message==='FILE_EXISTS')throw e;});
   await tar.c({file:dest,cwd:archiveRoot,gzip:i.format==='tar.gz',portable:true},paths.map(p=>relative(archiveRoot,p)));
   const st=await fs.stat(dest);
   if(st.size>i.maxBytes){await fs.rm(dest,{force:true});throw Error('ARCHIVE_TOO_LARGE');}
   return{path:dest,bytes:st.size};
 }
 if(i.action==='list'){
   const source=location(i.archivePath);
   if(source.endsWith('.zip')){
     const zip=new AdmZip(source);const entries=zip.getEntries();
     return{entries:entries.slice(0,i.limit??200).map(e=>({name:e.entryName,size:e.header.size,compressedSize:e.header.compressedSize,directory:e.isDirectory})),
       truncated:entries.length>(i.limit??200)};
   }
   const entries:any[]=[];
   await tar.t({file:source,onReadEntry(e:any){if(entries.length<(i.limit??200))entries.push({name:e.path,size:e.size,type:e.type});}});
   return{entries};
 }
 const source=location(i.archivePath),target=location(i.targetDirectory);
 await fs.mkdir(target,{recursive:true});
 if(source.endsWith('.zip')){
   const zip=new AdmZip(source),entries=zip.getEntries();
   if(entries.length>i.maxEntryCount)throw Error('ARCHIVE_ENTRY_LIMIT');
   let total=0;
   for(const entry of entries){
     safeArchiveEntry(target,entry.entryName);total+=entry.header.size;
     if(total>i.maxExpandedBytes)throw Error('ARCHIVE_EXPANSION_LIMIT');
     if(entry.attr & 0xA000)throw Error('SYMLINK_ARCHIVE_UNSUPPORTED');
   }
   for(const entry of entries){
     const out=safeArchiveEntry(target,entry.entryName);
     if(entry.isDirectory){await fs.mkdir(out,{recursive:true});continue;}
     await atomicWrite(out,entry.getData(),i.overwrite);
   }
   return{extracted:entries.length,expandedBytes:total,target};
 }
 // Restrict TAR extraction by validating entry paths upfront and during extraction. Hard expanded byte cap.
 let count=0,total=0;
 await tar.t({file:source,onReadEntry(e:any){
   safeArchiveEntry(target,e.path);
   if(e.type==='SymbolicLink'||e.type==='Link')throw Error('SYMLINK_ARCHIVE_UNSUPPORTED');
   count++;total+=e.size||0;
   if(count>i.maxEntryCount||total>i.maxExpandedBytes)throw Error('ARCHIVE_LIMIT_EXCEEDED');
 }});
 await tar.x({file:source,cwd:target,strict:true,preservePaths:false,
   filter:(p:string,e:any)=>{safeArchiveEntry(target,p);return e.type!=='SymbolicLink'&&e.type!=='Link';}});
 return{extracted:count,expandedBytes:total,target};
}
export async function fileTool(tool:string,input:Input,workspace?:string):Promise<any>{
 const path=input.path?location(input.path,workspace):'';
 switch(tool){
 case 'fs_read_many':{
   const budget=Math.min(65_536,input.maxTotalBytes??32_768);
   const results:any[]=[];
   let bytesUsed=0;
   for(const item of input.files as Input[]){
     const resolved=location(item.path,workspace);
     const remaining=budget-bytesUsed;
     if(remaining<=0){
       results.push({path:resolved,error:'BATCH_BUDGET_EXHAUSTED',truncated:true});
       continue;
     }
     try{
       const read=await fileTool('fs_read',{
         ...item,maxBytes:Math.min(item.maxBytes??4_096,8_192,remaining),
       },workspace);
       bytesUsed+=read.readBytes??0;
       if(input.includeHash)read.sha256=await fileHash(resolved);
       results.push(read);
     }catch(error){
       results.push({path:resolved,error:error instanceof Error?error.message:String(error)});
     }
   }
   return{files:results,bytesUsed,maxTotalBytes:budget,
     successCount:results.filter(x=>!x.error).length,
     failureCount:results.filter(x=>x.error).length,
     truncated:results.some(x=>x.truncated)};
 }
 case 'fs_stat':return{entries:await Promise.all(input.paths.map(async(p:string)=>{const resolved=location(p,workspace);try{return await statOne(resolved,input.hash);}catch(e:any){return{path:resolved,error:e.message};}}))};
 case 'fs_list':{
   const max=input.limit??200,queue=[{dir:path,depth:0}],entries:any[]=[];
   while(queue.length&&entries.length<max){
     const node=queue.shift()!;
     for(const item of await fs.readdir(node.dir,{withFileTypes:true})){
       if(entries.length>=max)break;
       if(!input.includeHidden&&item.name.startsWith('.'))continue;
       const child=join(node.dir,item.name),s=await fs.lstat(child);
       entries.push({path:child,name:item.name,type:item.isDirectory()?'directory':item.isFile()?'file':'other',size:s.size,modified:s.mtime.toISOString()});
       if(item.isDirectory()&&node.depth<(input.depth??1))queue.push({dir:child,depth:node.depth+1});
     }
   }
   return{entries,truncated:queue.length>0};
 }
 case 'fs_read':{
   const encoding=input.encoding??'utf8',hasLines=input.lineOffset!==undefined||input.maxLines!==undefined;
   const max=input.maxBytes??65536,st=await fs.stat(path);
   if(hasLines){
     if(encoding==='base64')throw Error('INCOMPATIBLE_FILE_RANGE: base64 does not support line offsets');
     if(input.byteOffset)throw Error('INCOMPATIBLE_FILE_RANGE: lineOffset cannot combine with byteOffset');
     const start=input.lineOffset??0,lineLimit=input.maxLines??10000;
     const decoded=encoding==='utf16le'?'utf16le':'utf8';
     const stream=createReadStream(path,{encoding:decoded,highWaterMark:65536});
     const lines=createInterface({input:stream,crlfDelay:Infinity});
     const collected:string[]=[];let scanned=0,bytes=0,truncated=false,ended=false;
     try{
       for await(const line of lines){
         if(scanned++<start)continue;
         if(collected.length>=lineLimit){truncated=true;break;}
         const needed=Buffer.byteLength((collected.length?'\n':'')+line,decoded);
         if(bytes+needed>max){
           if(collected.length===0)throw Error('LINE_EXCEEDS_MAX_BYTES: increase maxBytes');
           truncated=true;break;
         }
         collected.push(line);bytes+=needed;
       }
       ended=!truncated;
     }finally{lines.close();stream.destroy();}
     return{path,content:collected.join('\n'),encoding,readBytes:bytes,totalBytes:st.size,
       truncated,lineOffset:start,linesRead:collected.length,
       nextLineOffset:truncated?start+collected.length:null,
       ...(ended?{totalLines:scanned}:{})};
   }
   const h=await fs.open(path,'r');
   try{
     const offset=Math.min(st.size,input.byteOffset??0);
     const buffer=Buffer.alloc(Math.min(max,st.size-offset));
     const {bytesRead}=await h.read(buffer,0,buffer.length,offset);
     const content=buffer.subarray(0,bytesRead).toString(encoding==='base64'?'base64':encoding);
     return{path,content,encoding,readBytes:bytesRead,totalBytes:st.size,truncated:offset+bytesRead<st.size,
       nextByteOffset:offset+bytesRead<st.size?offset+bytesRead:null};
   }finally{await h.close();}
 }
 case 'fs_find':case 'fs_grep':return search(tool,input,path);
 case 'fs_write':{
   const data=Buffer.from(input.content,input.encoding==='base64'?'base64':'utf8');
   if(input.expectedHash){const original=await fs.readFile(path);if(hash(original)!==input.expectedHash)throw Error('FILE_VERSION_CONFLICT');}
   if(input.mode==='append')await fs.appendFile(path,data);
   else if(input.mode==='create')await fs.writeFile(path,data,{flag:'wx'});
   else await atomicWrite(path,data,true);
   return {path,writtenBytes:data.length,sha256:hash(data)};
 }
 case 'fs_edit':{
   const original=await fs.readFile(path,'utf8');
   if(input.expectedHash&&hash(utf8(original))!==input.expectedHash)throw Error('FILE_VERSION_CONFLICT');
   let changed:string;
   if(input.mode==='replace'){
     const occurrences=original.split(input.oldText).length-1;
     if(occurrences!==input.expectedReplacements)throw Error('REPLACEMENT_COUNT_MISMATCH '+occurrences);
     changed=original.split(input.oldText).join(input.newText);
   }else{
     const patched=applyPatch(original,input.patch);
     if(patched===false)throw Error('PATCH_CONTEXT_MISMATCH');
     changed=patched;
   }
   await atomicWrite(path,utf8(changed),true);
   return{path,sha256:hash(utf8(changed)),bytes:Buffer.byteLength(changed)};
 }
 case 'fs_manage':{
   const dest=input.destination?location(input.destination,workspace):'';
   switch(input.action){
    case 'mkdir':await fs.mkdir(path,{recursive:input.recursive});break;
    case 'remove':await fs.rm(path,{recursive:input.recursive,force:false});break;
    case 'copy':await fs.cp(path,dest,{recursive:input.recursive,force:input.overwrite,errorOnExist:!input.overwrite});break;
    case 'move':case 'rename':if(!input.overwrite)await fs.stat(dest).then(()=>{throw Error('FILE_EXISTS');}).catch(e=>{if(e.message==='FILE_EXISTS')throw e;});await fs.rename(path,dest);break;
   }
   return{ok:true,path,destination:dest||undefined};
 }
 case 'fs_archive':return archive(input);
 default:throw Error('FILE_TOOL_NOT_IMPLEMENTED: '+tool);
 }
}
