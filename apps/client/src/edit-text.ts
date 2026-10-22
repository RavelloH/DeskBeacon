import {applyPatch} from 'diff';

export type Replacement={oldText:string;newText:string;expectedReplacements?:number};
export type EditTextRequest=
 | {mode:'replace';oldText:string;newText:string;expectedReplacements?:number}
 | {mode:'replace_many';replacements:Replacement[]}
 | {mode:'patch';patch:string};

type EolKind='CRLF'|'LF'|'CR'|'mixed'|'none';
function lineEndings(text:string):EolKind{
 const crlf=(text.match(/\r\n/g)??[]).length;
 const lf=(text.match(/(?<!\r)\n/g)??[]).length;
 const cr=(text.match(/\r(?!\n)/g)??[]).length;
 const types=Number(crlf>0)+Number(lf>0)+Number(cr>0);
 if(types>1)return 'mixed';
 return crlf?'CRLF':lf?'LF':cr?'CR':'none';
}
/** Return a canonical LF string and a map of every canonical boundary into source offsets. */
function mappedLf(source:string){
 let text='',offset=0;
 const boundaries=[0];
 while(offset<source.length){
  if(source[offset]==='\r'&&source[offset+1]==='\n'){
   text+='\n';offset+=2;
  }else if(source[offset]==='\r'){
   text+='\n';offset++;
  }else{
   text+=source[offset]!;offset++;
  }
  boundaries.push(offset);
 }
 return {text,boundaries};
}
function occurrences(value:string,needle:string):number[]{
 const found:number[]=[];
 if(!needle)return found;
 let index=0;
 while((index=value.indexOf(needle,index))!==-1){
  found.push(index);
  index+=needle.length;
 }
 return found;
}
function preferredEol(original:string,region:string):string{
 const local=lineEndings(region);
 if(local==='CRLF')return '\r\n';
 if(local==='LF')return '\n';
 if(local==='CR')return '\r';
 const whole=lineEndings(original);
 if(whole==='CRLF')return '\r\n';
 if(whole==='CR')return '\r';
 if(whole==='mixed'){
  // Preserve the file's most common style without normalizing unaffected lines.
  const crlf=(original.match(/\r\n/g)??[]).length;
  const lf=(original.match(/(?<!\r)\n/g)??[]).length;
  return crlf>=lf?'\r\n':'\n';
 }
 return '\n';
}
function diagnostic(original:string,oldText:string,exact:number,normalized:number,expected:number):Error{
 const file= lineEndings(original),needle=lineEndings(oldText);
 const normalizedText=mappedLf(original).text,firstLine=mappedLf(oldText).text.split('\n')
  .map(line=>line.trim()).find(line=>line.length>0);
 const candidates:number[]=[];
 if(firstLine){
  for(const [index,line] of normalizedText.split('\n').entries()){
   if(line.includes(firstLine)){candidates.push(index+1);if(candidates.length===5)break;}
  }
 }
 return Error('REPLACEMENT_COUNT_MISMATCH exact='+exact+' normalized='+normalized+
  ' expected='+expected+' fileEOL='+file+' inputEOL='+needle+
  ' candidateLines='+ (candidates.length?candidates.join(','):'none')+
  '; matching ignores line-ending differences only; no file changes were written');
}
function replaceOne(original:string,{oldText,newText,expectedReplacements=1}:Replacement):{
 text:string;count:number;normalizedEol:boolean
}{
 const exact=occurrences(original,oldText);
 const normalizedEol=exact.length!==expectedReplacements;
 // Most edits match exactly; allocate a boundary map only for cross-EOL fallback.
 const canonical=normalizedEol?mappedLf(original):null;
 const target=normalizedEol?mappedLf(oldText).text:null;
 const matches=normalizedEol?occurrences(canonical!.text,target!):exact;
 if(matches.length!==expectedReplacements)
  throw diagnostic(original,oldText,exact.length,matches.length,expectedReplacements);
 const edits=matches.map(index=>{
  const start=normalizedEol?canonical!.boundaries[index]!:index;
  const end=normalizedEol?canonical!.boundaries[index+target!.length]!:index+oldText.length;
  const region=original.slice(start,end);
  const eol=preferredEol(original,region);
  return {start,end,value:newText.replace(/\r\n?|\n/g,eol)};
 });
 let text=original;
 for(const change of edits.reverse())
  text=text.slice(0,change.start)+change.value+text.slice(change.end);
 return {text,count:matches.length,normalizedEol};
}
export function editText(original:string,input:EditTextRequest){
 if(input.mode==='patch'){
  // diff's own line-ending conversion preserves CRLF source files.
  const changed=applyPatch(original,input.patch,{autoConvertLineEndings:true,fuzzFactor:0});
  if(changed===false)throw Error('PATCH_CONTEXT_MISMATCH fileEOL='+lineEndings(original)+
   ' patchEOL='+lineEndings(input.patch)+'; no file changes were written');
  return {text:changed,replacements:0,normalizedEol:false};
 }
 const edits=input.mode==='replace'?[input]:input.replacements;
 let text=original,replacements=0,normalizedEol=false;
 for(const edit of edits){
  const result=replaceOne(text,edit);
  text=result.text;replacements+=result.count;
  normalizedEol ||= result.normalizedEol;
 }
 return {text,replacements,normalizedEol};
}
