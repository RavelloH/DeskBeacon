import {existsSync,lstatSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {logsDir} from './diagnostics-paths.js';

/** Only files created by exportFlightRecorderSnapshots qualify for removal. */
const ownedSnapshot=/^flight-[a-zA-Z0-9_-]{1,32}-\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:service|runtime|connection|execution|migration|security|tui)\.jsonl$/;
export const snapshotRetention={maxFiles:32,maxBytes:8*1024*1024,maxAgeMs:14*24*60*60*1000} as const;

type Entry={path:string;mtime:number;bytes:number;name:string};
/** Best-effort, never follows symlinks and never deletes non-DeskBeacon files. */
export function pruneCrashSnapshots(preservePaths:readonly string[]=[]):{
 inspected:number;deleted:number;deletedBytes:number;remaining:number;remainingBytes:number
}{
 const keep=new Set(preservePaths);
 let entries:Entry[]=[];
 if(!existsSync(logsDir))return {inspected:0,deleted:0,deletedBytes:0,remaining:0,remainingBytes:0};
 try{
  for(const name of readdirSync(logsDir)){
   if(!ownedSnapshot.test(name))continue;
   const path=join(logsDir,name);
   try{
    const info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink())continue;
    entries.push({name,path,mtime:info.mtimeMs,bytes:info.size});
   }catch{}
  }
 }catch{return {inspected:0,deleted:0,deletedBytes:0,remaining:0,remainingBytes:0};}
 entries.sort((a,b)=>b.mtime-a.mtime||b.name.localeCompare(a.name));
 const inspected=entries.length;
 let count=entries.length,bytes=entries.reduce((sum,entry)=>sum+entry.bytes,0);
 let deleted=0,deletedBytes=0;
 const now=Date.now();
 // Iterate oldest first; do not delete files from the current crash export.
 for(const entry of entries.slice().reverse()){
  if(keep.has(entry.path))continue;
  const expired=now-entry.mtime>snapshotRetention.maxAgeMs;
  if(!expired&&count<=snapshotRetention.maxFiles&&bytes<=snapshotRetention.maxBytes)continue;
  try{
   // A file could be replaced between discovery and deletion; reject changed
   // files and all symlinks. Never recurse into directories.
   const current=lstatSync(entry.path);
   if(!current.isFile()||current.isSymbolicLink()||current.size!==entry.bytes||current.mtimeMs!==entry.mtime)continue;
   rmSync(entry.path);
   deleted++;deletedBytes+=entry.bytes;count--;bytes-=entry.bytes;
  }catch{}
 }
 return {inspected,deleted,deletedBytes,remaining:count,remainingBytes:bytes};
}
