import {previewFromEdges,type OutputPreview} from '@deskbeacon/protocol';

type Page={text:string;totalBytes:number;nextOffset:number;available?:boolean};
type FetchPage=(request:{action:'output'|'result';operationId:string;stream?:'stdout';byteOffset:number;maxBytes:number})=>Promise<Page>;

/** Only two small IPC pages are read for a selected DETAIL, regardless of log size. */
export async function loadSelectedOutputPreview(
 id:string,fetchPage:FetchPage,budget=4096,hasFullOutput=true,target:'output'|'result'='output'
):Promise<OutputPreview|null>{
 const args=(byteOffset:number)=>({action:target,operationId:id,
  ...(target==='output'?{stream:'stdout' as const}:{}),byteOffset,maxBytes:budget});
 const head=await fetchPage(args(0));
 if(head.available===false)return null;
 let tail=head.text;
 if(head.totalBytes>budget){
  const start=Math.max(0,head.totalBytes-budget);
  for(let skip=0;skip<=4;skip++){
   try{tail=(await fetchPage(args(start+skip))).text;break;}
   catch(error){
    if(!String(error).includes('INVALID_BYTE_OFFSET')||skip===4)throw error;
   }
  }
 }
 return previewFromEdges(head.text,tail,head.totalBytes,budget,{hasFullOutput});
}
