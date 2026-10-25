import {createPreview,previewFromEdges,type OutputPreview} from '@deskbeacon/protocol';

export type DetailKind='input'|'output';
export type PreviewPreference='balanced'|'head'|'tail';
export type DetailBlock={kind:DetailKind;title:string;text:string;preference?:PreviewPreference;language?:string;startLine?:number|null;sourcePreview?:OutputPreview|undefined};
export type DetailSection={kind:DetailKind;preview:OutputPreview;language?:string;title?:string;startLine?:number|null;lineMap?:Array<number|null>};
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;

const marker=/\n… \[中间省略 \d+ 字节 · 查看完整输出\] …\n/;
function sizedPreview(group:{text:string;mode:PreviewPreference;sourcePreview?:OutputPreview|undefined},budget:number){
 const ratioValue=ratio(group.mode),options=ratioValue===undefined?{}:{headRatio:ratioValue};
 if(group.sourcePreview?.truncated){
  const source=group.sourcePreview,hit=marker.exec(source.text);
  if(hit){
   const head=source.text.slice(0,hit.index),tail=source.text.slice(hit.index+hit[0].length);
   return previewFromEdges(head,tail,source.originalBytes,budget,
    {...options,...(source.totalLines===undefined?{}:{totalLines:source.totalLines})});
  }
 }
 return createPreview(group.text,budget,options);
}
/** One 4 KiB budget shared across all dynamic INPUT/OUTPUT content in DETAIL. */
export function createDetailSections(blocks:readonly DetailBlock[],budget=4096):DetailSection[]{
 const groups=(['input','output'] as const).map(kind=>{
  const members=blocks.filter(block=>block.kind===kind && block.text!=='');
  if(!members.length)return null;
  // Multiple file chunks share one budget, but each keeps its OWN source line
  // numbers; artificial headings and omission markers never get a line number.
  let lineMap:Array<number|null>|undefined;
  let text=members[0]!.text;
  if(members.length>1){
   const rows:string[]=[],numbers:Array<number|null>=[];
   for(const [index,member] of members.entries()){
    if(index){rows.push('');numbers.push(null);}
    rows.push('['+member.title+']');numbers.push(null);
    const value=member.text.replace(/\r\n?/g,'\n');
    const lines=(value.endsWith('\n')?value.slice(0,-1):value).split('\n');
    const omissionIndex=lines.findIndex(v=>/… \[中间省略 \d+ 字节/.test(v));
    for(const [n,line] of lines.entries()){
     rows.push(line);
     const relative=omissionIndex>=0&&n>omissionIndex&&member.sourcePreview?.tailStartLine!==undefined
      ?member.sourcePreview.tailStartLine+(n-omissionIndex-1):
      n+1;
     numbers.push(omissionIndex===n||member.startLine===null||member.startLine===undefined||
      omissionIndex>=0&&n>omissionIndex&&member.sourcePreview?.tailStartLine===undefined
      ?null:member.startLine+relative-1);
    }
   }
   text=rows.join('\n');lineMap=numbers;
  }
  const mode=members.every(block=>block.preference==='head')?'head':
    members.every(block=>block.preference==='tail')?'tail':'balanced' as PreviewPreference;
  const language=members.length===1?members[0]?.language:undefined;
  const title=members.length===1?members[0]?.title:undefined;
  const startLine=members.length===1?members[0]?.startLine:undefined;
  const sourcePreview=members.length===1?members[0]?.sourcePreview:undefined;
  return{kind,text,mode,language,title,startLine,sourcePreview,lineMap,size:bytes(text)};
 }).filter((group):group is NonNullable<typeof group>=>group!==null);
 if(!groups.length)return[];
 if(groups.length===1){
  const g=groups[0]!;
  return[{kind:g.kind,preview:sizedPreview(g,budget),
    ...(g.language?{language:g.language}:{}),
   ...(g.title?{title:g.title}:{}),...(g.startLine!==undefined?{startLine:g.startLine}:{}),
   ...(g.lineMap?{lineMap:g.lineMap}:{})}];
 }
 // Account for both groups' budgets and leave unused capacity for the longer
 // section. 128 B minimum leaves room for UTF-8 omissions and a visible label.
 const contentBudget=budget;
 const input=groups.find(g=>g.kind==='input')!,output=groups.find(g=>g.kind==='output')!;
 let inputBudget=Math.max(128,Math.min(input.size,Math.floor(contentBudget*.45)));
 let outputBudget=Math.max(128,Math.min(output.size,contentBudget-inputBudget));
 if(inputBudget+outputBudget<contentBudget){
  inputBudget=Math.max(128,Math.min(input.size,contentBudget-outputBudget));
  outputBudget=Math.max(128,Math.min(output.size,contentBudget-inputBudget));
 }
 // Tiny groups remain complete. A truncated group needs >=128 B for marker
 // and meaningful context; borrow from the other group without losing bytes.
 if(inputBudget<input.size&&inputBudget<128){inputBudget=128;outputBudget=contentBudget-inputBudget;}
 if(outputBudget<output.size&&outputBudget<128){outputBudget=128;inputBudget=contentBudget-outputBudget;}
 return groups.map(g=>({
  kind:g.kind,preview:sizedPreview(g,g.kind==='input'?inputBudget:outputBudget),
  ...(g.language?{language:g.language}:{}),
  ...(g.title?{title:g.title}:{}),...(g.startLine!==undefined?{startLine:g.startLine}:{}),
  ...(g.lineMap?{lineMap:g.lineMap}:{})
 }));
}
function ratio(mode:PreviewPreference):number|undefined{
 return mode==='head'?.8:mode==='tail'?.2:undefined;
}
