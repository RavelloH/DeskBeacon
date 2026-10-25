/**
 * Bounded, UTF-8-safe previews shared by the Worker, CLI and TUI.
 * The returned text is a DISPLAY preview, never a substitute for persisted output.
 */
export type PreviewStrategy="full"|"balanced"|"result_priority";
export type PreviewReason="none"|"preview_budget";
export interface OutputPreview {
 text:string;
 truncated:boolean;
 reason:PreviewReason;
 strategy:PreviewStrategy;
 originalBytes:number;
 displayedBytes:number;
 omittedBytes:number;
 hasFullOutput:boolean;
}
const encoder=new TextEncoder();
const decoder=new TextDecoder();
const marker=(omitted:number)=>"\n… [中间省略 "+omitted+" 字节 · 查看完整输出] …\n";
const byteLength=(value:string)=>encoder.encode(value).length;

function bytePrefix(bytes:Uint8Array,budget:number):string{
 if(budget<=0)return "";
 let size=Math.min(budget,bytes.length);
 if(size<bytes.length)while(size>0&&(bytes[size]!&0xc0)===0x80)size--;
 let text=decoder.decode(bytes.subarray(0,size));
 // Avoid cutting through a line when there is a nearby line boundary.
 const breakAt=text.lastIndexOf("\n");
 if(size<bytes.length&&breakAt>=text.length*.7&&breakAt>=0)text=text.slice(0,breakAt+1);
 return text;
}
function byteSuffix(bytes:Uint8Array,budget:number):string{
 if(budget<=0)return "";
 let start=Math.max(0,bytes.length-budget);
 while(start<bytes.length&&(bytes[start]!&0xc0)===0x80)start++;
 let text=decoder.decode(bytes.subarray(start));
 const breakAt=text.indexOf("\n");
 if(start>0&&breakAt>=0&&breakAt<text.length*.3)text=text.slice(breakAt+1);
 return text;
}
/**
 * The edges must be at the actual beginning and end of a stream.
 * originalBytes may include the omitted middle, so no large intermediate
 * buffer is necessary on a streaming host.
 */
export function previewFromEdges(
 headSource:string,tailSource:string,originalBytes:number,budget:number,
 options:{hasFullOutput?:boolean;headRatio?:number}={}
):OutputPreview{
 if(!Number.isSafeInteger(budget)||budget<64)throw new RangeError("INVALID_PREVIEW_BUDGET");
 if(!Number.isSafeInteger(originalBytes)||originalBytes<0)throw new RangeError("INVALID_ORIGINAL_BYTES");
 const hasFullOutput=options.hasFullOutput!==false;
 const headBytes=encoder.encode(headSource),tailBytes=encoder.encode(tailSource);
 const fullAvailable=headBytes.byteLength>=originalBytes;
 if(originalBytes<=budget&&fullAvailable)return{
  text:bytePrefix(headBytes,originalBytes),truncated:false,reason:"none",
  strategy:"full",originalBytes,displayedBytes:originalBytes,omittedBytes:0,hasFullOutput
 };
 const strategy:PreviewStrategy=originalBytes<=budget*4?"balanced":"result_priority";
 // Reserve room for a UTF-8 marker and its variable-length omitted byte count.
 const contentBudget=Math.max(0,budget-80);
 const defaultRatio=strategy==="balanced"?.5:.25;
 const headRatio=options.headRatio??defaultRatio;
 if(!Number.isFinite(headRatio)||headRatio<0||headRatio>1)throw new RangeError("INVALID_PREVIEW_RATIO");
 const headBudget=Math.floor(contentBudget*headRatio);
 const tailBudget=contentBudget-headBudget;
 let head=bytePrefix(headBytes,headBudget),tail=byteSuffix(tailBytes,tailBudget);
 let shown=byteLength(head)+byteLength(tail);
 let omitted=Math.max(0,originalBytes-shown);
 let text=head+marker(omitted)+tail;
 if(byteLength(text)>budget)throw new Error("PREVIEW_EXCEEDS_BUDGET");
 return {text,truncated:true,reason:"preview_budget",strategy,originalBytes,
  displayedBytes:shown,omittedBytes:omitted,hasFullOutput};
}
export function createPreview(
 text:string,budget:number,options:{hasFullOutput?:boolean;headRatio?:number}={}
):OutputPreview{
 const bytes=encoder.encode(text);
 // Both arguments denote *actual* ends of the same UTF-8 input.
 return previewFromEdges(text,text,bytes.byteLength,budget,options);
}
