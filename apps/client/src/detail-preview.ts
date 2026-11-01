import {createPreview,previewFromEdges,splitOutputPreview,type OutputPreview} from '@deskbeacon/protocol';

export type DetailKind='input'|'output';
export type PreviewPreference='balanced'|'head'|'tail';
export type PreviewEdgeOmission={
 direction:'head'|'tail';
 omittedCount?:number;
 unit?:'characters'|'bytes'|'lines';
 fullSourceAvailable?:boolean;
};
export type DetailBlock={
 kind:DetailKind;
 title:string;
 text:string;
 preference?:PreviewPreference;
 language?:string;
 startLine?:number|null;
 sourcePreview?:OutputPreview|undefined;
 edgeOmission?:PreviewEdgeOmission;
};
export type DetailSectionPart={
 title?:string;
 preview:OutputPreview;
 language?:string;
 startLine?:number|null;
 sourceText?:string;
 edgeOmission?:PreviewEdgeOmission;
};
export type DetailSection={kind:DetailKind;parts:DetailSectionPart[]};
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;
const sourceSize=(block:DetailBlock)=>Math.max(bytes(block.text),block.sourcePreview?.originalBytes??0);

function ratio(mode:PreviewPreference):number|undefined{
 return mode==='head'?.8:mode==='tail'?.2:undefined;
}
function sizedPreview(block:DetailBlock,budget:number):OutputPreview{
 const safeBudget=Math.max(64,budget);
 const ratioValue=ratio(block.preference??'balanced');
 const source=block.sourcePreview;
 const options={
  ...(ratioValue===undefined?{}:{headRatio:ratioValue}),
  hasFullOutput:source?.hasFullOutput??block.edgeOmission?.fullSourceAvailable??true
 };
 if(source?.truncated){
  const split=splitOutputPreview(source);
  if(split)return previewFromEdges(split.head,split.tail,source.originalBytes,safeBudget,{
   ...options,...(source.totalLines===undefined?{}:{totalLines:source.totalLines})
  });
 }
 return createPreview(block.text,safeBudget,options);
}
/** Allocate one byte budget fairly across logical content blocks, redistributing unused bytes. */
function allocateBudgets(sizes:number[],budget:number):number[]{
 if(sizes.reduce((sum,size)=>sum+size,0)<=budget)return [...sizes];
 const allocations=sizes.map(size=>Math.min(size,64));
 let remaining=budget-allocations.reduce((sum,size)=>sum+size,0);
 let active=sizes.map((_,index)=>index).filter(index=>sizes[index]!>allocations[index]!);
 while(remaining>0&&active.length){
  const share=Math.floor(remaining/active.length);
  if(share<=0)break;
  const completed=active.filter(index=>sizes[index]!-allocations[index]!<=share);
  if(completed.length){
   for(const index of completed){
    const need=sizes[index]!-allocations[index]!;
    allocations[index]=sizes[index]!;
    remaining-=need;
   }
   const done=new Set(completed);
   active=active.filter(index=>!done.has(index));
   continue;
  }
  const base=Math.floor(remaining/active.length),extra=remaining%active.length;
  active.forEach((index,position)=>{
   allocations[index]=Math.min(sizes[index]!,allocations[index]!+base+(position<extra?1:0));
  });
  remaining=0;
 }
 return allocations;
}
/** One 4 KiB budget shared across every dynamic INPUT/OUTPUT content block in DETAIL. */
export function createDetailSections(blocks:readonly DetailBlock[],budget=4096):DetailSection[]{
 if(!Number.isSafeInteger(budget)||budget<64)throw new RangeError('INVALID_DETAIL_PREVIEW_BUDGET');
 const visible=blocks.filter(block=>block.text!=='');
 if(!visible.length)return[];
 const sizes=visible.map(sourceSize);
 // If an unusually large multi-file operation has more blocks than can receive
 // a useful minimum preview, collapse each side into one explicitly titled preview.
 if(sizes.reduce((sum,size)=>sum+size,0)>budget&&visible.length*64>budget){
  const grouped=(['input','output'] as const).map(kind=>({
   kind,members:visible.filter(block=>block.kind===kind)
  })).filter(group=>group.members.length);
  const groupSizes=grouped.map(group=>group.members.reduce((sum,block)=>sum+sourceSize(block),0));
  const groupBudgets=allocateBudgets(groupSizes,budget);
  return grouped.map((group,index)=>{
   const text=group.members.map(block=>'['+block.title+']\n'+block.text).join('\n\n');
   return{kind:group.kind,parts:[{
    preview:createPreview(text,Math.max(64,groupBudgets[index]??64)),
    startLine:null
   }]};
  });
 }
 const budgets=allocateBudgets(sizes,budget);
 return (['input','output'] as const).map(kind=>{
  const parts:DetailSectionPart[]=[];
  visible.forEach((block,index)=>{
   if(block.kind!==kind)return;
   const preview=sizedPreview(block,budgets[index]??64);
   const sourceSizeBytes=bytes(block.text);
   const fullTextMatchesSource=!block.sourcePreview?.truncated||
    sourceSizeBytes===(block.sourcePreview?.originalBytes??sourceSizeBytes);
   parts.push({
    preview,
    ...(block.title?{title:block.title}:{}),
    ...(block.language?{language:block.language}:{}),
    ...(block.startLine!==undefined?{startLine:block.startLine}:{}),
    ...(fullTextMatchesSource?{sourceText:block.text}:{}),
    ...(block.edgeOmission?{edgeOmission:block.edgeOmission}:{})
   });
  });
  return{kind,parts};
 }).filter(group=>group.parts.length>0);
}
