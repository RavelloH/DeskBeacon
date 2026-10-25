import {highlightCodeLines,type CodeSpan} from './syntax-highlight.js';

const ordinary=['#000000','#C66D78','#92C999','#D8B579','#83BFE1','#C1A4D9','#7AC8C7','#D5D5D5'];
const bright=['#757575','#F18E96','#B0E7AF','#F0CE82','#A9D6FF','#D5B9EE','#9AE1E2','#FFFFFF'];
const neutral='#969696';
const color256=(value:number):string=>{
 if(value<16)return (value<8?ordinary:bright)[value%8]!;
 if(value>=232){
  const n=8+(value-232)*10;return '#'+[n,n,n].map(v=>v.toString(16).padStart(2,'0')).join('');
 }
 const index=value-16,channel=[Math.floor(index/36)%6,Math.floor(index/6)%6,index%6]
  .map(v=>v===0?0:55+v*40);
 return '#'+channel.map(v=>v.toString(16).padStart(2,'0')).join('');
};
export type StyledSource={lines:string[];spans:CodeSpan[][];hasNativeColor:boolean};
function logSpans(text:string):CodeSpan[]{
 // Unknown stdout is not guessed as source code. Common terminal/log
 // diagnostics still receive restrained semantic colors.
 const level=/\b(ERROR|FATAL|FAIL(?:ED)?|WARN(?:ING)?|INFO|DEBUG|TRACE|SUCCESS|PASS(?:ED)?)\b/gi;
 const out:CodeSpan[]=[],add=(value:string,color:string)=>{
  if(!value)return;
  const last=out.at(-1);
  if(last?.color===color)last.text+=value;
  else out.push({text:value,color});
 };
 const diff=/^(?:\+\+\+|---|\+|-|@@)/.exec(text);
 if(diff){
  add(text,diff[0].startsWith('+')?'#9ED1A3':diff[0].startsWith('-')?'#E3A3A3':'#ABC5E1');
  return out;
 }
 let offset=0;
 for(const match of text.matchAll(level)){
  add(text.slice(offset,match.index),neutral);
  const label=match[0].toUpperCase();
  add(match[0],/ERROR|FATAL|FAIL/.test(label)?'#F18E96':
   /WARN/.test(label)?'#F0CE82':/PASS|SUCCESS/.test(label)?'#9ED1A3':'#A9D6FF');
  offset=match.index+match[0].length;
 }
 add(text.slice(offset),neutral);
 return out;
}
/** Sanitize terminal escape sequences while preserving trusted SGR foreground color.
 * Never allow terminal cursor/OSC control sequences to reach Ink rendering. */
export function styleTerminalSource(raw:string,language?:string):StyledSource{
 const sequences=/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b.|\r\n?|\n)/g;
 let foreground:string|undefined,bold=false,index=0,plain='',hasNativeColor=false;
 const rawStyles:Array<{text:string;color?:string}>=[];
 const emit=(fragment:string)=>{
  if(!fragment)return;
  // Preserve newline boundaries; filter remaining control characters safely.
  fragment=fragment.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');
  if(!fragment)return;
  plain+=fragment;
  const last=rawStyles.at(-1),color=foreground;
  if(last&&last.color===color)last.text+=fragment;
  else rawStyles.push({text:fragment,...(color?{color}:{})});
 };
 const sgr=(seq:string)=>{
  const v=seq.slice(2,-1);
  const args=(v?v.split(';').map(n=>Number(n)): [0]);
  for(let i=0;i<args.length;i++){
   const n=args[i]!;
   if(n===0){foreground=undefined;bold=false;}
   else if(n===1)bold=true;
   else if(n===22)bold=false;
   else if(n===39)foreground=undefined;
   else if(n>=30&&n<=37){foreground=(bold?bright:ordinary)[n-30];hasNativeColor=true;}
   else if(n>=90&&n<=97){foreground=bright[n-90];hasNativeColor=true;}
   else if(n===38){
    const mode=args[i+1],x=args[i+2];
    if(mode===5&&x!==undefined&&x>=0&&x<=255){
     foreground=color256(x);hasNativeColor=true;i+=2;
    }else if(mode===2&&i+4<args.length){
     const rgb=args.slice(i+2,i+5);
     if(rgb.every(k=>k!==undefined&&k>=0&&k<=255)){
      foreground='#'+rgb.map(k=>k!.toString(16).padStart(2,'0')).join('');
      hasNativeColor=true;
     }
     i+=4;
    }
   }
  }
 };
 for(const match of raw.matchAll(sequences)){
  emit(raw.slice(index,match.index));
  const seq=match[0];
  if(seq==='\n'||seq==='\r\n')emit('\n');
  else if(seq==='\r')emit('\n');
  else if(seq.startsWith('\x1b[')&&seq.endsWith('m'))sgr(seq);
  index=match.index+seq.length;
 }
 emit(raw.slice(index));
 const lines=plain.split('\n');
 const spans:CodeSpan[][]=lines.map(()=>[]);
 const lexical=language?highlightCodeLines(lines,language):null;
 // ANSI foreground takes priority; fill uncolored intervals with language tokens.
 const flatLex=(lexical??lines.map(logSpans)).flatMap((line,i)=>
  i<lines.length-1?[...line,{text:'\n',color:neutral}]:line);
 const fragments:CodeSpan[]=[];
 let lexIndex=0,lexOffset=0;
 for(const rawStyle of rawStyles){
  let offset=0;
  while(offset<rawStyle.text.length){
   const token=flatLex[lexIndex];
   if(!token){fragments.push({text:rawStyle.text.slice(offset),color:rawStyle.color??neutral});break;}
   const available=token.text.length-lexOffset;
   if(available<=0){lexIndex++;lexOffset=0;continue;}
   const slice=rawStyle.text.slice(offset,offset+available);
   fragments.push({text:slice,color:rawStyle.color??token.color});
   offset+=slice.length;lexOffset+=slice.length;
   if(lexOffset===token.text.length){lexIndex++;lexOffset=0;}
  }
 }
 let row=0;
 for(const piece of fragments){
  for(const [i,part] of piece.text.split('\n').entries()){
   if(i)row++;
   if(part&&row<spans.length){
    const target=spans[row]!,last=target.at(-1);
    if(last?.color===piece.color)last.text+=part;
    else target.push({text:part,color:piece.color});
   }
  }
 }
 // Lexing colors remain only if the rendered plaintext matches byte-for-byte.
 if(spans.some((row,i)=>row.map(x=>x.text).join('')!==lines[i]))
  return{lines,spans:lines.map(x=>[{text:x,color:neutral}]),hasNativeColor};
 return{lines,spans,hasNativeColor};
}
export function detectOutputLanguage(raw:string):string|undefined{
 const stripped=raw.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'').trim();
 if(!stripped)return undefined;
 if(/^[\[{]/.test(stripped)){
  try{JSON.parse(stripped);return 'json';}catch{}
 }
 const lines=stripped.split(/\r?\n/).filter(Boolean);
 if(lines.length>=2&&lines.length<=4000&&lines.slice(0,40).every(x=>{
  try{const v=JSON.parse(x);return v!==null&&typeof v==='object';}catch{return false;}
 }))return 'json';
 return undefined;
}
