import {watch,type FSWatcher,statSync} from 'node:fs';
import {join} from 'node:path';

export type OutputChanged={taskId:string;stream:'stdout'|'stderr';size:number};
/** One watcher for any number of TUI connections, created only while subscribed. */
export class OutputWatchHub{
 private readonly clients=new Map<object,{ids:Set<string>;notify:(change:OutputChanged)=>void}>();
 private watcher:FSWatcher|undefined;
 private pending=new Map<string,ReturnType<typeof setTimeout>>();
 private sizes=new Map<string,number>();
 constructor(private readonly directory:string){}
 set(client:object,ids:readonly string[],notify:(change:OutputChanged)=>void){
  const selected=new Set(ids.filter(id=>/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)));
  if(selected.size)this.clients.set(client,{ids:selected,notify});
  else this.clients.delete(client);
  if(!this.clients.size){this.shutdown();return;}
  const active=new Set([...this.clients.values()].flatMap(entry=>[...entry.ids]));
  for(const key of this.sizes.keys())if(!active.has(key.split('\0')[0]!))this.sizes.delete(key);
  for(const [key,timer] of this.pending)if(!active.has(key.split('\0')[0]!)){
   clearTimeout(timer);this.pending.delete(key);
  }
  if(this.watcher)return;
  try{
   this.watcher=watch(this.directory,(_event,filename)=>{
    if(!filename){for(const entry of this.clients.values())for(const id of entry.ids)
     for(const stream of ['stdout','stderr'] as const)this.queue(id,stream);return;}
    const name=filename.toString();
    const match=/^(.+)\.(out|err)$/.exec(name);
    if(!match)return;
    const fileId=match[1]!,stream=match[2]==='out'?'stdout':'stderr';
    for(const entry of this.clients.values())for(const id of entry.ids)
      if(id.replace(/[^a-zA-Z0-9_.-]/g,'_')===fileId)this.queue(id,stream);
   });
   this.watcher.on('error',()=>{this.watcher?.close();this.watcher=undefined;});
  }catch{/* Unsupported filesystem notification: history remains readable on demand. */}
 }
 delete(client:object){
  this.clients.delete(client);
  if(!this.clients.size)this.shutdown();
 }
 private queue(id:string,stream:'stdout'|'stderr'){
  const key=id+'\0'+stream;
  if(this.pending.has(key))return;
  this.pending.set(key,setTimeout(()=>{
   this.pending.delete(key);
   if(![...this.clients.values()].some(entry=>entry.ids.has(id)))return;
   let size=0;
   try{size=statSync(join(this.directory,id.replace(/:/g,'_')+(stream==='stdout'?'.out':'.err'))).size;}catch{return;}
   if(this.sizes.get(key)===size)return;
   this.sizes.set(key,size);
   const change={taskId:id,stream,size};
   for(const entry of this.clients.values())if(entry.ids.has(id))entry.notify(change);
  },80));
 }
 private shutdown(){
  this.watcher?.close();this.watcher=undefined;
  for(const timer of this.pending.values())clearTimeout(timer);
  this.pending.clear();this.sizes.clear();
 }
}
