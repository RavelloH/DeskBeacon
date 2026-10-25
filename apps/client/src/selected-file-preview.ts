import type {ActivityEntry} from './presenter.js';

/** Load only the selected file operation, never all history rows. The CLI
 * limits each IPC page to 64 KiB; selected summaries are bounded at 128 KiB. */
const maxSelectedBytes=128*1024;
const pageBytes=64*1024;
type Source='input'|'result';
export type SelectedFilePreview={
 id:string;source:Source;json?:string;limited:boolean;available:boolean;
};
export type PreviewPage={text:string;nextOffset:number;totalBytes:number;hasMore:boolean;available?:boolean};
const parse=(value?:string|null):Record<string,unknown>=>{
 try{const obj=JSON.parse(value??'{}');return obj&&typeof obj==='object'&&!Array.isArray(obj)?obj:{};}
 catch{return{};}
};
export function missingSelectedFileSource(entry:ActivityEntry):Source|null{
 if(entry.tool==='fs_write'||entry.tool==='fs_edit'){
  const input=parse(entry.request_json);
  if(entry.tool==='fs_edit')
   return input.previewLimited===true?'input':null;
  return input.previewLimited===true||typeof input.content!=='string'||input.content==='[redacted]'?'input':null;
 }
 if(entry.tool==='fs_read'){
  const result=parse(entry.result);
  return result.previewLimited===true||typeof result.content!=='string'||result.content==='[redacted]'?'result':null;
 }
 if(entry.tool==='fs_read_many'){
  const result=parse(entry.result);
  return Array.isArray(result.files)&&!result.previewLimited?null:'result';
 }
 return null;
}
export async function loadSelectedFilePreview(entry:ActivityEntry,
 request:(args:{action:Source;operationId:string;byteOffset:number;maxBytes:number})=>Promise<PreviewPage>
):Promise<SelectedFilePreview|null>{
 const source=missingSelectedFileSource(entry);
 if(!source)return null;
 let offset=0,total:number|null=null;
 const chunks:string[]=[];
 while(true){
  const page=await request({action:source,operationId:entry.id,byteOffset:offset,maxBytes:pageBytes});
  if(page.available===false)return{id:entry.id,source,limited:false,available:false};
  if(total===null)total=page.totalBytes;
  if(total>maxSelectedBytes)return{id:entry.id,source,limited:true,available:true};
  if(page.totalBytes!==total||page.nextOffset<=offset&&page.hasMore||
    page.nextOffset>maxSelectedBytes||page.nextOffset>total)
   return{id:entry.id,source,limited:false,available:false};
  chunks.push(page.text);
  offset=page.nextOffset;
  if(!page.hasMore)break;
 }
 if(offset!==total)return{id:entry.id,source,limited:false,available:false};
 try{
  const json=JSON.stringify(JSON.parse(chunks.join('')));
  return{id:entry.id,source,json,limited:false,available:true};
 }catch{
  return{id:entry.id,source,limited:false,available:false};
 }
}
export function withSelectedFilePreview(entry:ActivityEntry,preview:SelectedFilePreview|null):ActivityEntry{
 if(!preview||preview.id!==entry.id||!preview.json)return entry;
 return preview.source==='input'?{...entry,request_json:preview.json}:{...entry,result:preview.json};
}
