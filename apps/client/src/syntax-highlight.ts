import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import dos from 'highlight.js/lib/languages/dos';
import powershell from 'highlight.js/lib/languages/powershell';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';

export type CodeSpan={text:string;color:string};
const base='#969696';
const colors:Record<string,string>={
 keyword:'#C6A8DC',selector_tag:'#C6A8DC',literal:'#C6A8DC',
 string:'#A8CDA0',regexp:'#A8CDA0',template_tag:'#A8CDA0',
 number:'#D9B88C',attribute:'#D9B88C',attr:'#D9B88C',variable:'#D9B88C',
 comment:'#747474',quote:'#747474',
 title:'#ABC5E1',function:'#ABC5E1',built_in:'#ABC5E1',built_in_:'#ABC5E1',
 type:'#B6C8DF',class:'#B6C8DF',params:'#AFAFAF',
 meta:'#BCA5CB',symbol:'#C5B2DB',bullet:'#C5B2DB',addition:'#9ED1A3',deletion:'#E3A3A3',
 section:'#ABC5E1',strong:'#ECECEC',emphasis:'#CBB2DD',code:'#A8CDA0',link:'#A8CDA0',
 tag:'#B6C8DF',name:'#ABC5E1'
};
for(const [id,grammar] of Object.entries({
 bash,dos,powershell,javascript,typescript,python,rust,go,cpp,c,java,json,yaml,xml,css,sql,markdown,ruby,php
}))hljs.registerLanguage(id,grammar);

const ext:Record<string,string>={
 sh:'bash',bash:'bash',zsh:'bash',fish:'bash',bat:'dos',cmd:'dos',ps1:'powershell',psm1:'powershell',psd1:'powershell',
 js:'javascript',cjs:'javascript',mjs:'javascript',jsx:'javascript',
 ts:'typescript',cts:'typescript',mts:'typescript',tsx:'typescript',
 py:'python',pyw:'python',rs:'rust',go:'go',c:'c',h:'c',cc:'cpp',cpp:'cpp',cxx:'cpp',hpp:'cpp',
 java:'java',json:'json',jsonc:'json',yaml:'yaml',yml:'yaml',html:'xml',htm:'xml',xml:'xml',
 svg:'xml',css:'css',scss:'css',sql:'sql',md:'markdown',mdx:'markdown',rb:'ruby',php:'php'
};
export function languageForPath(path:unknown):string|undefined{
 if(typeof path!=='string'||!path)return undefined;
 const name=path.replace(/\\/g,'/').split('/').at(-1)?.toLowerCase()??'';
 if(['dockerfile','makefile','justfile'].includes(name))return 'bash';
 if(name==='.bashrc'||name==='.zshrc'||name==='.profile')return 'bash';
 return ext[name.split('.').at(-1)??''];
}
export function languageForCommand(command:unknown):string{
 if(!command||typeof command!=='object')return 'bash';
 const c=command as {mode?:string;program?:string;args?:unknown[];shellProfile?:string;shell?:string};
 const signature=[c.program,c.shellProfile,c.shell].filter(Boolean).join(' ').toLowerCase();
 if(/\b(pwsh|powershell)(\.exe)?\b/.test(signature))return 'powershell';
 if(/\b(cmd)(\.exe)?\b/.test(signature))return 'dos';
 // 'node -e ...' and 'python -m ...' are command lines, not standalone source code.
 return 'bash';
}
function htmlDecode(s:string):string{
 return s.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));/gi,entity=>{
  if(entity==='&amp;')return '&';
  if(entity==='&lt;')return '<';
  if(entity==='&gt;')return '>';
  if(entity==='&quot;')return '"';
  if(entity==='&apos;')return "'";
  if(entity.startsWith('&#')){
   const number=entity.slice(2,-1);
   const v=number[0]?.toLowerCase()==='x'?parseInt(number.slice(1),16):parseInt(number,10);
   return Number.isFinite(v)&&v>=0&&v<=0x10ffff?String.fromCodePoint(v):entity;
  }
  return entity;
 });
}
function codeColor(classes:string):string{
 const tokens=classes.split(/\s+/);
 for(const token of tokens){
  const key=token.replace(/^hljs-/,'').replace(/_$/,'');
  if(colors[key])return colors[key];
 }
 return base;
}
/** Cached lexical analysis minimizes CPU during rapid selection and window resizing. */
const lexCache=new Map<string,CodeSpan[]>();
/** Convert highlight.js HTML to safe, unescaped Ink text spans; no ANSI or HTML reaches the terminal. */

/** Preserve multiline lexical state while distributing colored spans to source lines. */
export function highlightCodeLines(lines:string[],language:string):CodeSpan[][]{
 const out:CodeSpan[][]=lines.map(()=>[]);
 let row=0;
 for(const span of highlightCode(lines.join('\n'),language)){
  const fragments=span.text.split('\n');
  for(let i=0;i<fragments.length;i++){
   if(i)row++;
   if(row>=out.length)break;
   const text=fragments[i]??'';
   if(!text)continue;
   const target=out[row]!;
   const last=target.at(-1);
   if(last&&last.color===span.color)last.text+=text;
   else target.push({text,color:span.color});
  }
 }
 if(out.some((spans,i)=>spans.map(s=>s.text).join('')!==lines[i]))
  return lines.map(text=>[{text,color:base}]);
 return out;
}

export function highlightCode(code:string,language:string):CodeSpan[]{
 if(!code||!hljs.getLanguage(language))return [{text:code,color:base}];
 // For full INPUT / OUTPUT inspectors, lex large sources in bounded chunks
 // instead of silently disabling all highlighting after 20k characters.
 if(code.length>20000){
  const result:CodeSpan[]=[];
  let start=0;
  while(start<code.length){
   let end=Math.min(code.length,start+16000);
   if(end<code.length){
    const newline=code.lastIndexOf('\n',end);
    if(newline>start+1000)end=newline+1;
   }
   const spans=highlightCode(code.slice(start,end),language);
   for(const span of spans){
    const last=result.at(-1);
    if(last&&last.color===span.color)last.text+=span.text;
    else result.push({...span});
   }
   start=end;
  }
  return result;
 }
 const cacheKey=language+'\u0000'+code;
 const prior=lexCache.get(cacheKey);
 if(prior)return prior;
 let html:string;
 try{html=hljs.highlight(code,{language,ignoreIllegals:true}).value;}
 catch{return [{text:code,color:base}];}
 const spans:CodeSpan[]=[],stack:string[]=[];
 const push=(text:string,color:string)=>{
  if(!text)return;
  const last=spans.at(-1);
  if(last&&last.color===color)last.text+=text;
  else spans.push({text,color});
 };
 const tags=/(<span\b[^>]*>|<\/span>|&(?:amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));)/gi;
 let start=0,match:RegExpExecArray|null;
 while((match=tags.exec(html))!==null){
  push(html.slice(start,match.index),stack.at(-1)??base);
  const value=match[0];
  if(value.startsWith('<span')){
   const classes=/class="([^"]+)"/.exec(value)?.[1]??'';
   const selected=codeColor(classes);
   stack.push(selected===base?(stack.at(-1)??base):selected);
  }else if(value==='</span>')stack.pop();
  else push(htmlDecode(value),stack.at(-1)??base);
  start=tags.lastIndex;
 }
 push(html.slice(start),stack.at(-1)??base);
 if(spans.map(s=>s.text).join('')!==code)return [{text:code,color:base}];
 if(lexCache.size>=24){const eldest=lexCache.keys().next().value;if(eldest!==undefined)lexCache.delete(eldest);}
 lexCache.set(cacheKey,spans);
 return spans;
}
