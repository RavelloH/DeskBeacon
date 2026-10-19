import type {FullSource} from './detail-inspector.js';
type Page={text:string;nextOffset:number;totalBytes:number;hasMore:boolean;stream:string;available?:boolean};
/** Read to the fixed byte-length observed at the start, so running logs
 * cannot prevent completion while their producers keep appending output. */
export async function readEntireLocalStream(
 read:(offset:number)=>Promise<Page>,
 onProgress?:(loaded:number,total:number)=>void,
):Promise<FullSource>{
 let offset=0,target:number|null=null,text='',available=true;
 for(;;){
  const page=await read(offset);
  if(page.available===false)return {text:'',totalBytes:0,available:false};
  if(target===null)target=page.totalBytes;
  if(page.nextOffset<offset||(page.nextOffset===offset&&offset<target))
   throw Error('LOCAL_STREAM_STALLED');
  text+=page.text;
  offset=page.nextOffset;
  onProgress?.(Math.min(offset,target),target);
  if(offset>=target||!page.hasMore)break;
 }
 return {text,totalBytes:target??0,available};
}
