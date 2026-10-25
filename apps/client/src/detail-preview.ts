import {createPreview,type OutputPreview} from '@deskbeacon/protocol';

export type DetailKind='input'|'output';
export type PreviewPreference='balanced'|'head'|'tail';
export type DetailBlock={kind:DetailKind;title:string;text:string;preference?:PreviewPreference;language?:string;startLine?:number|null};
export type DetailSection={kind:DetailKind;preview:OutputPreview;language?:string;title?:string;startLine?:number|null};
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;

/** One 4 KiB budget shared across all dynamic INPUT/OUTPUT content in DETAIL. */
export function createDetailSections(blocks:readonly DetailBlock[],budget=4096):DetailSection[]{
 const groups=(['input','output'] as const).map(kind=>{
  const members=blocks.filter(block=>block.kind===kind && block.text!=='');
  if(!members.length)return null;
  const text=members.length===1?members[0]!.text:
   members.map(block=>'['+block.title+']\n'+block.text).join('\n\n');
  const mode=members.every(block=>block.preference==='head')?'head':
    members.every(block=>block.preference==='tail')?'tail':'balanced' as PreviewPreference;
  const language=members.length===1?members[0]?.language:undefined;
  const title=members.length===1?members[0]?.title:undefined;
  const startLine=members.length===1?members[0]?.startLine:undefined;
  return{kind,text,mode,language,title,startLine,size:bytes(text)};
 }).filter((group):group is NonNullable<typeof group>=>group!==null);
 if(!groups.length)return[];
 if(groups.length===1){
  const g=groups[0]!;
  return[{kind:g.kind,preview:createPreview(g.text,budget,ratio(g.mode)===undefined?{}:{headRatio:ratio(g.mode)!}),
    ...(g.language?{language:g.language}:{}),
  ...(g.title?{title:g.title}:{}),...(g.startLine!==undefined?{startLine:g.startLine}:{}),
    ...(g.title?{title:g.title}:{}),...(g.startLine!==undefined?{startLine:g.startLine}:{})}];
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
  kind:g.kind,preview:createPreview(g.text,g.kind==='input'?inputBudget:outputBudget,
    ratio(g.mode)===undefined?{}:{headRatio:ratio(g.mode)!}),
  ...(g.language?{language:g.language}:{}),
  ...(g.title?{title:g.title}:{}),...(g.startLine!==undefined?{startLine:g.startLine}:{})
 }));
}
function ratio(mode:PreviewPreference):number|undefined{
 return mode==='head'?.8:mode==='tail'?.2:undefined;
}
