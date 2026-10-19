import {spawnSync} from 'node:child_process';
import {TextDecoder} from 'node:util';
import {readSync,openSync,closeSync,statSync} from 'node:fs';

/**
 * Windows native console applications may emit bytes in the active OEM code
 * page even when the controlling PowerShell or Node process uses UTF-8.
 * Keep the files byte-for-byte unchanged; decode only when exposing text.
 */
const codePageLabels:Record<number,string>={
  936:'gb18030',950:'big5',932:'shift_jis',949:'euc-kr',
  1250:'windows-1250',1251:'windows-1251',1252:'windows-1252',
  1253:'windows-1253',1254:'windows-1254',1255:'windows-1255',
  1256:'windows-1256',1257:'windows-1257',1258:'windows-1258',
  866:'ibm866',874:'windows-874'
};
let cachedLegacy:string|null|undefined;
export function windowsLegacyEncoding():string|null{
 if(process.platform!=='win32')return null;
 if(cachedLegacy!==undefined)return cachedLegacy;
 const override=process.env.DESKBEACON_OEM_ENCODING?.trim();
 if(override){
  try{new TextDecoder(override);return cachedLegacy=override;}catch{}
 }
 try{
  // chcp output is ASCII digits regardless of the active console language.
  const result=spawnSync('cmd.exe',['/d','/c','chcp'],{timeout:2500,windowsHide:true});
  const match=/\b([0-9]{3,5})\b/.exec(result.stdout?.toString('latin1')??'');
  const page=Number(match?.[1]??0);
  if(page===65001)return cachedLegacy=null;
  const label=codePageLabels[page];
  if(label){new TextDecoder(label);return cachedLegacy=label;}
 }catch{}
 return cachedLegacy=null;
}
function validUtf8Prefix(bytes:Buffer):boolean{
 try{
  // stream=true permits a multibyte code point split at the sample boundary.
  new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:true});
  return true;
 }catch{return false;}
}
export function outputEncoding(bytes:Buffer,mode:'auto'|'utf8'|'system'='auto'):string{
 if(mode==='utf8'||process.platform!=='win32')return 'utf-8';
 const legacy=windowsLegacyEncoding();
 if(!legacy)return 'utf-8';
 if(mode==='system')return legacy;
 return validUtf8Prefix(bytes)?'utf-8':legacy;
}
export function decodeOutputText(bytes:Buffer,mode:'auto'|'utf8'|'system'='auto'):string{
 return new TextDecoder(outputEncoding(bytes,mode)).decode(bytes);
}
type ScanState={scanned:number;decoder:TextDecoder|null;encoding:string};
const fileEncodingCache=new Map<string,ScanState>();
export function detectFileOutputEncoding(path:string,byteOffset=0,mode:'auto'|'utf8'|'system'='auto'):string{
 if(mode==='utf8'||process.platform!=='win32')return 'utf-8';
 const legacy=windowsLegacyEncoding();
 if(!legacy)return 'utf-8';
 if(mode==='system')return legacy;
 const size=statSync(path).size;
 let cached=fileEncodingCache.get(path);
 if(!cached||size<cached.scanned){
  cached={scanned:0,decoder:new TextDecoder('utf-8',{fatal:true}),encoding:'utf-8'};
 }
 // Scan from the START in order, never from an unvalidated requested cursor:
 // cursor offsets may point inside a valid UTF-8 scalar. Incremental scanning
 // also detects CP936 text appearing after a long ASCII-only introduction.
 const through=Math.min(size,Math.max(65536,byteOffset+65536));
 if(cached.decoder&&cached.scanned<through){
  const fd=openSync(path,'r');
  try{
   while(cached.scanned<through){
    const n=Math.min(65536,through-cached.scanned);
    const bytes=Buffer.allocUnsafe(n);
    const read=readSync(fd,bytes,0,n,cached.scanned);
    if(read<=0)break;
    cached.scanned+=read;
    try{cached.decoder.decode(bytes.subarray(0,read),{stream:true});}
    catch{cached.encoding=legacy;cached.decoder=null;break;}
   }
  }finally{closeSync(fd);}
 }
 // Bounded LRU: 96 active/historical log files, no permanent per-operation cache.
 fileEncodingCache.delete(path);fileEncodingCache.set(path,cached);
 if(fileEncodingCache.size>96)fileEncodingCache.delete(fileEncodingCache.keys().next().value!);
 return cached.encoding;
}
/** Decode a bounded page without splitting multibyte characters.
 * Only probe three trailing bytes, never repeatedly decode an entire large
 * buffer for malformed binary or mixed-encoding subprocess output. */
export function decodeOutputPage(bytes:Buffer,budget:number,encoding:string):{text:string;used:number}{
 if(bytes.length===0)return{text:'',used:0};
 const proposed=Math.min(Math.max(1,budget),bytes.length);
 const valid=(end:number)=>{
  try{new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(0,end));return true;}
  catch{return false;}
 };
 let used=0;
 for(let trim=0;trim<=3&&proposed-trim>0;trim++){
  if(valid(proposed-trim)){used=proposed-trim;break;}
 }
 // The budget can be smaller than the first Unicode scalar; allow up to
 // three lookahead bytes, but return its entire encoding atomically.
 if(!used&&proposed<4)
  for(let n=proposed+1;n<=Math.min(4,bytes.length);n++)
   if(valid(n)){used=n;break;}
 // Malformed binary text must still advance rather than looping forever.
 if(!used)used=proposed;
 return{text:new TextDecoder(encoding).decode(bytes.subarray(0,used)),used};
}
