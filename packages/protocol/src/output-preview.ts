/**
 * Bounded, UTF-8-safe previews shared by the Worker, CLI and TUI.
 * The returned text is a DISPLAY preview, never a substitute for persisted output.
 */
export type PreviewStrategy="full"|"balanced"|"result_priority";
export type PreviewReason="none"|"preview_budget";
export type PreviewOmissionDirection="head"|"middle"|"tail";
export interface OutputPreview {
 text:string;
 truncated:boolean;
 reason:PreviewReason;
 strategy:PreviewStrategy;
 originalBytes:number;
 displayedBytes:number;
 omittedBytes:number;
 hasFullOutput:boolean;
 totalLines?:number;
 headLines?:number;
 tailStartLine?:number;
 /** Character offsets for the internal marker; absent on legacy snapshots. */
 omissionStart?:number;
 omissionEnd?:number;
 omissionDirection?:PreviewOmissionDirection;
 /** Exact omitted logical line count when both edges and total line count are known. */
 omittedLines?:number;
}
export interface OutputPreviewParts {
 head:string;
 tail:string;
 direction:PreviewOmissionDirection;
}
const legacyMarker=/\n… \[中间省略 \d+ 字节(?: · 查看完整输出)?\] …\n/;;
/** Split a preview using metadata first, with a compatibility parser for old receipts. */
export function splitOutputPreview(
 preview:Pick<OutputPreview,"text"|"truncated"|"omissionStart"|"omissionEnd"|"omissionDirection">
):OutputPreviewParts|null{
 if(!preview.truncated)return null;
 const {text}=preview;
 const start=preview.omissionStart,end=preview.omissionEnd;
 if(Number.isInteger(start)&&Number.isInteger(end)&&start!>=0&&end!>=start!&&end!<=text.length){
  const head=text.slice(0,start),tail=text.slice(end);
  return{head,tail,direction:preview.omissionDirection??(!head?"head":!tail?"tail":"middle")};
 }
 const match=legacyMarker.exec(text);
 if(!match)return null;
 const head=text.slice(0,match.index),tail=text.slice(match.index+match[0].length);
 return{head,tail,direction:!head?"head":!tail?"tail":"middle"};
}
const encoder=new TextEncoder();
const decoder=new TextDecoder();
const marker=(omitted:number)=>"\n… [中间省略 "+omitted+" 字节 · 查看完整输出] …\n";
const byteLength=(value:string)=>encoder.encode(value).length;
const countLines=(value:string)=>value.length?value.split('\n').length-(value.endsWith('\n')?1:0):0;

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
 options:{hasFullOutput?:boolean;headRatio?:number;totalLines?:number}={}
):OutputPreview{
 if(!Number.isSafeInteger(budget)||budget<64)throw new RangeError("INVALID_PREVIEW_BUDGET");
 if(!Number.isSafeInteger(originalBytes)||originalBytes<0)throw new RangeError("INVALID_ORIGINAL_BYTES");
 const hasFullOutput=options.hasFullOutput!==false;
 const headBytes=encoder.encode(headSource),tailBytes=encoder.encode(tailSource);
 const fullAvailable=headBytes.byteLength>=originalBytes;
 if(originalBytes<=budget&&fullAvailable)return{
  text:bytePrefix(headBytes,originalBytes),truncated:false,reason:"none",
  strategy:"full",originalBytes,displayedBytes:originalBytes,omittedBytes:0,hasFullOutput,
  totalLines:options.totalLines??countLines(headSource)
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
 const shown=byteLength(head)+byteLength(tail);
 const omitted=Math.max(0,originalBytes-shown);
 const omission=marker(omitted);
 const text=head+omission+tail;
 if(byteLength(text)>budget)throw new Error("PREVIEW_EXCEEDS_BUDGET");
 const omissionDirection:PreviewOmissionDirection=!head?"head":!tail?"tail":"middle";
 const tailStartLine=options.totalLines===undefined?undefined:
  Math.max(1,options.totalLines-countLines(tail)+1);
 const omittedLines=omissionDirection==="middle"&&tailStartLine!==undefined
  ?Math.max(0,tailStartLine-countLines(head)-1):undefined;
 return {text,truncated:true,reason:"preview_budget",strategy,originalBytes,
  displayedBytes:shown,omittedBytes:omitted,hasFullOutput,
  headLines:countLines(head),omissionStart:head.length,
  omissionEnd:head.length+omission.length,omissionDirection,
  ...(options.totalLines===undefined?{}:{totalLines:options.totalLines,tailStartLine:tailStartLine!,
    ...(omittedLines===undefined?{}:{omittedLines})})};
}
export function createPreview(
 text:string,budget:number,options:{hasFullOutput?:boolean;headRatio?:number;totalLines?:number}={}
):OutputPreview{
 const bytes=encoder.encode(text);
 // Both arguments denote *actual* ends of the same UTF-8 input.
 return previewFromEdges(text,text,bytes.byteLength,budget,
  {...options,totalLines:countLines(text)});
}
