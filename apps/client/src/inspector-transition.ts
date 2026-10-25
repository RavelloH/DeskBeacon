/** Prevent asynchronous inspector loads from exposing placeholders or stale views. */
export class AtomicInspectorSwitch<T extends {totalBytes:number}>{
 private version=0;
 private readonly cache=new Map<string,T>();
 constructor(private readonly maxEntries=12,private readonly maxCachedBytes=512*1024){}
 cancel(){this.version++;}
 /**
  * Keep the previous panel unchanged while loading. The caller commits both
  * the source and tab only from onReady(), after the response is complete.
  */
 async show(key:string,load:()=>Promise<T>,onReady:(value:T)=>void,
  onError:(error:unknown)=>void,options:{force?:boolean;valid?:()=>boolean}={}):Promise<void>{
  const version=++this.version;
  const ready=(value:T)=>{
   if(version!==this.version||options.valid&&!options.valid())return;
   onReady(value);
  };
  const cached=options.force?undefined:this.cache.get(key);
  if(cached){ready(cached);return;}
  try{
   const value=await load();
   if(version!==this.version||options.valid&&!options.valid())return;
   if(value.totalBytes<=this.maxCachedBytes){
    this.cache.delete(key);this.cache.set(key,value);
    while(this.cache.size>this.maxEntries){
     const oldest=this.cache.keys().next().value;
     if(oldest===undefined)break;
     this.cache.delete(oldest);
    }
   }
   ready(value);
  }catch(error){
   if(version===this.version&&(!options.valid||options.valid()))onError(error);
  }
 }
}
