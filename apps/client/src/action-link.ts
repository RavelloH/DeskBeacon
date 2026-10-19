import {existsSync,statSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {basename,isAbsolute,resolve} from 'node:path';
import type {ActivityEntry} from './presenter.js';

const fileTools=new Set(['fs_read','fs_read_many','fs_write','fs_edit','fs_stat',
 'fs_manage','fs_archive','transfer_upload','transfer_download']);
export type ActivityFileLink={path:string;label:string;line?:number};

export function activityFileLink(entry:ActivityEntry):ActivityFileLink|null{
 if(!fileTools.has(entry.tool))return null;
 let input:Record<string,any>={};
 try{input=JSON.parse(entry.request_json??'{}');}catch{return null;}
 const candidate=entry.tool==='fs_read_many'?input.files?.[0]?.path:
  entry.tool==='fs_stat'?input.paths?.[0]:
  input.path??input.targetPath??input.sourcePath??input.archivePath??input.outputPath;
 if(typeof candidate!=='string'||!candidate.trim())return null;
 const path=isAbsolute(candidate)?candidate:resolve(entry.cwd||process.cwd(),candidate);
 const offset=entry.tool==='fs_read_many'?input.files?.[0]?.lineOffset:input.lineOffset;
 const line=Number.isSafeInteger(offset)&&offset>=0?offset+1:undefined;
 return {path,label:basename(candidate)||candidate,...(line?{line}:{})};
}

/** Never pass untrusted historical paths through a command shell. */
export function openActivityFile(link:ActivityFileLink):Promise<string>{
 if(!existsSync(link.path)||!statSync(link.path).isFile())
  return Promise.resolve('文件不存在或不是普通文件：'+link.path);
 const target=link.path+(link.line?':'+link.line:'');
 return new Promise(resolve=>{
  const child=spawn('code',['--goto',target],{windowsHide:true,detached:true,stdio:'ignore',shell:false});
  let finished=false;
  const complete=(message:string)=>{if(!finished){finished=true;resolve(message);}};
  child.once('error',()=>complete('未找到 VS Code 的 code 命令；请将其加入 PATH'));
  child.once('spawn',()=>{child.unref();complete('已在 VS Code 中打开 '+link.label);});
 });
}

/** XTerm SGR mouse mode, using 1-based terminal coordinates. */
export function decodeSgrMouse(value:string):Array<{kind:'wheel'|'move'|'press';x:number;y:number;button:number;ctrl:boolean;direction:number}>{
 return [...value.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].flatMap(match=>{
  const bits=Number(match[1]),x=Number(match[2]),y=Number(match[3]);
  if(match[4]!=='M'||x<1||y<1)return [];
  const kind=bits&64?'wheel':bits&32?'move':'press';
  return [{kind,x,y,button:bits&3,ctrl:Boolean(bits&16),direction:bits&1?1:-1}];
 });
}
