/** Turn terminal diagnostics into human-readable MCP output without losing local raw logs. */
const ansi=/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const control=/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/g;
function readable(text:string):string{
 return text.replace(ansi,'').replace(control,'').replace(/\r\n?/g,'\n')
  .replace(/[ \t]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
}
function xmlDecode(text:string):string{
 return text.replace(/_x([0-9a-fA-F]{4})_/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)))
  .replace(/&#(x[0-9a-fA-F]+|\d+);/g,(_,value:string)=>
   String.fromCodePoint(value[0]?.toLowerCase()==='x'?parseInt(value.slice(1),16):parseInt(value,10)))
  .replace(/&(lt|gt|quot|apos|amp);/g,(_,name:string)=>({
    lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'
  })[name as 'lt'|'gt'|'quot'|'apos'|'amp']);
}
export function normalizeProcessStderr(raw:string):string{
 if(!raw)return '';
 const isCliXml=/#<\s*CLIXML|<Objs(?:\s|>)/i.test(raw)&&/<S\s+S=["']Error["']>/i.test(raw);
 if(isCliXml){
  // Preview buffers may end midway through an XML error element.
  const errors=[...raw.matchAll(/<S\s+S=["']Error["']>([\s\S]*?)(?:<\/S>|(?=<S\s+S=["']Error["']>)|$)/gi)]
   .map(match=>readable(xmlDecode(match[1]??'').replace(/<\/?Objs[^>]*>/g,''))).filter(Boolean);
  if(errors.length)return errors.filter((message,index)=>index===0||message!==errors[index-1]).join('\n');
 }
 return readable(raw);
}
export function errorSummary(stderr:string,exitCode:number|null):string|undefined{
 if(exitCode===0||!stderr)return undefined;
 const lines=stderr.split('\n').map(x=>x.trim()).filter(Boolean);
 // Prefer the actual error message over PowerShell's headings and locations.
 const meaningful=lines.map(line=>line.replace(/^[|:]\s*/,''))
  .filter(line=>!/^((?:\d+\s*\|)|\+|at |CategoryInfo|FullyQualifiedErrorId|所在位置|位置 |Line\s*\||Write-Error:\s*$|Exception:\s*$|~+$)/i.test(line));
 return meaningful.at(-1)?.slice(0,400)??lines[0]?.slice(0,400);
}
