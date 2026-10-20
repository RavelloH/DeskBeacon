import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,openSync,closeSync,writeSync,rmSync,readFileSync,statSync,readdirSync,readSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {dataDir} from './daemon.js';
import {RecordJournal,recordRelativePath} from './record-journal.js';
import {migrateLegacyRecords} from './legacy-migration.js';
import {logEvent,diagnosticDataDir} from './diagnostics.js';

export type MigrationProgress={stage:string;from:string;to:string;completed:number;total:number;percent:number;elapsedMs:number;etaMs:number|null;detail?:string|undefined};
export type MigrationResult={from:string;to:string;steps:string[];changed:boolean;removedOldOutput:boolean};
type Step={version:string;run:(ctx:Context)=>Promise<void>};
type Context={db:DatabaseSync;journal:RecordJournal;root:string;emit:(stage:string,done:number,total:number,detail?:string)=>void};
const VERSION_FALLBACK='0.1.0';
const versionKey='storage_version';
const migrationLock='migration.lock';
function cmp(a:string,b:string):number{
 const split=(s:string)=>{const match=/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(s);if(!match)throw Error('INVALID_VERSION: '+s);return match.slice(1,4).map(Number);};
 const x=split(a),y=split(b);for(let i=0;i<3;i++)if((x[i]??0)!==(y[i]??0))return (x[i]??0)<(y[i]??0)?-1:1;
 return 0;
}
declare const __DESKBEACON_PACKAGE_VERSION__:string;
export function codeVersion():string{
 if(typeof __DESKBEACON_PACKAGE_VERSION__!=='undefined')return __DESKBEACON_PACKAGE_VERSION__;
 const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
 return p.version;
}
export function storedVersion(db:DatabaseSync):string{
 const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_metadata'").get();
 if(!table)return VERSION_FALLBACK;
 const row=db.prepare('SELECT value FROM storage_metadata WHERE key=?').get(versionKey) as {value:string}|undefined;
 return row?.value??VERSION_FALLBACK;
}
function putVersion(db:DatabaseSync,version:string):void{
 db.exec('CREATE TABLE IF NOT EXISTS storage_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 db.prepare('INSERT INTO storage_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run(versionKey,version);
}
function column(db:DatabaseSync,table:string,column:string,def:string){
 if(!(db.prepare('PRAGMA table_info('+table+')').all() as {name:string}[]).some(row=>row.name===column))
  db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+def);
}
function schema(db:DatabaseSync):void{
 db.exec('CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,grant_id TEXT,tool TEXT,description TEXT,status TEXT,time INTEGER,result TEXT)');
 db.exec('CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,status TEXT,created INTEGER,result TEXT)');
 db.exec('CREATE TABLE IF NOT EXISTS background(id TEXT PRIMARY KEY,operation_id TEXT,description TEXT,pid INTEGER,status TEXT,start INTEGER,exit_code INTEGER,stdout_path TEXT,stderr_path TEXT)');
 for(const [name,type] of Object.entries({request_json:'TEXT',finished_at:'INTEGER',duration_ms:'INTEGER',cwd:'TEXT',actor_name:'TEXT',record_path:'TEXT',record_state:'TEXT',outcome:'TEXT',exit_code:'INTEGER',error_code:'TEXT',record_bytes:'INTEGER'}))column(db,'activity',name,type);
 for(const [name,type] of Object.entries({stdout_truncated:'INTEGER DEFAULT 0',stderr_truncated:'INTEGER DEFAULT 0',record_path:'TEXT'}))column(db,'background',name,type);
 db.exec('CREATE TABLE IF NOT EXISTS unacked_results(operation_id TEXT PRIMARY KEY,tool TEXT,created INTEGER,device_id TEXT)');
}
function listFiles(dir:string):string[]{
 if(!existsSync(dir))return[];
 const files:string[]=[],folders=[dir];
 while(folders.length){const folder=folders.pop()!;for(const ent of readdirSync(folder,{withFileTypes:true})){const full=join(folder,ent.name);if(ent.isDirectory())folders.push(full);else if(ent.isFile())files.push(full);}}
 return files;
}
function stageEmit(ctx:Context,stage:string,done:number,total:number,detail?:string){ctx.emit(stage,done,total,detail);}
function readRaw(file:string,max=32*1024*1024):unknown{
 const size=statSync(file).size;
 if(size>max)throw Error('LEGACY_ORPHAN_INPUT_TOO_LARGE: '+file);
 const s=readFileSync(file,'utf8');
 try{return JSON.parse(s);}catch{return{legacyRaw:s};}
}
function migrateOrphan(ctx:Context,base:string,files:Map<string,string>):void{
 const id='legacy-orphan:'+base;
 const rel=recordRelativePath(id,0);
 if(ctx.journal.exists(rel)){
  const previous=ctx.journal.getResult(rel);
  if(!previous)throw Error('ORPHAN_JOURNAL_INCOMPLETE: '+base);
 }else{
  const input=files.get('input')?readRaw(files.get('input')!):{legacyFile:base};
  ctx.journal.start(id,'legacy_orphan',input,{time:0});
  try{
   for(const stream of ['stdout','stderr'] as const){
    const file=files.get(stream);if(!file)continue;
    const fd=openSync(file,'r'),chunk=Buffer.allocUnsafe(65536);
    try{for(;;){const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;ctx.journal.stream(id,stream,chunk.subarray(0,n));}}
    finally{closeSync(fd);}
   }
   ctx.journal.finish(id,{description:'Unlinked legacy output retained during upgrade',legacyFile:base},'completed');
  }catch(e){ctx.journal.close(id);throw e;}
 }
 ctx.db.prepare("INSERT OR IGNORE INTO activity(id,grant_id,tool,description,status,time,record_path,record_state,outcome) VALUES(?,'','legacy_orphan',?,'completed',0,?,'legacy_partial','success')")
  .run(id,'Unlinked legacy output: '+base,rel);
}
function verifyRecord(ctx:Context,row:{id:string;record_path:string|null;outcome:string|null;status:string;tool:string|null}):void{
 if(!row.record_path)throw Error('UNMIGRATED_ACTIVITY: '+row.id);
 if(!ctx.journal.exists(row.record_path))throw Error('MISSING_JOURNAL: '+row.id);
 const head=ctx.journal.getInput(row.record_path);
 if(head===null)throw Error('MISSING_JOURNAL_INPUT: '+row.id);
 if(!row.outcome){
  const result=ctx.journal.getResult(row.record_path)?.result??{};
  const data=result&&typeof result==='object'&&result.data&&typeof result.data==='object'?result.data:result;
  const failed=row.status==='failed'||Boolean(data?.error||data?.spawnError||data?.timedOut||data?.isError)||
   (typeof data?.exitCode==='number'&&data.exitCode!==0)||Number(data?.failed??data?.failureCount??0)>0;
  const outcome=['interrupted','running','queued','accepted','started'].includes(row.status)?
    (row.status==='interrupted'?'interrupted':'running'):(failed?'failed':'success');
  ctx.db.prepare('UPDATE activity SET outcome=?,exit_code=coalesce(exit_code,?) WHERE id=?')
   .run(outcome,Number.isSafeInteger(data?.exitCode)?data.exitCode:null,row.id);
 }
}
async function migrateTo020(ctx:Context):Promise<void>{
 stageEmit(ctx,'准备本地存储',0,1);
 schema(ctx.db);
 const count=(ctx.db.prepare("SELECT count(*) n FROM activity WHERE record_path IS NULL").get() as {n:number}).n;
 const originalCount=(ctx.db.prepare("SELECT count(*) n FROM activity").get() as {n:number}).n;
 const out=join(ctx.root,'output'),outputFiles=listFiles(out);
 const progressTotal=Math.max(1,count+originalCount+outputFiles.length+1);
 let moved=0;stageEmit(ctx,'迁移操作记录',0,progressTotal);
 const report=await migrateLegacyRecords(ctx.db,ctx.journal,ctx.root,n=>{
  moved+=n;stageEmit(ctx,'迁移操作记录',Math.min(moved,count),progressTotal);
 });
 if(report.errors)throw Error('LEGACY_MIGRATION_FAILED: '+report.errors+' record(s) could not be converted');
 // Completed/failed operations without a receipt/body still require a durable metadata record.
 const incomplete=ctx.db.prepare("SELECT id,tool,time,request_json,result,status FROM activity WHERE record_path IS NULL").all() as
  {id:string;tool:string|null;time:number|null;request_json:string|null;result:string|null;status:string|null}[];
 for(const row of incomplete){
  const at=Number(row.time??Date.now()),rel=recordRelativePath(row.id,at);
  if(!ctx.journal.exists(rel)){
   ctx.journal.start(row.id,row.tool??'legacy_unknown',row.request_json?JSON.parse(row.request_json):{legacyUnknown:true},{time:at});
   ctx.journal.finish(row.id,row.result?JSON.parse(row.result):{legacyMissingResult:true,legacyStatus:row.status},
    row.status==='failed'?'failed':'completed');
  }
  ctx.db.prepare("UPDATE activity SET record_path=?,record_state='legacy_partial',request_json=NULL,result=NULL WHERE id=?").run(rel,row.id);
 }
 moved=count;
 const rows=ctx.db.prepare("SELECT id,record_path,outcome,status,tool FROM activity WHERE record_path IS NOT NULL").all() as
  {id:string;record_path:string;outcome:string|null;status:string;tool:string|null}[];
 let i=0;
 for(const row of rows){
  verifyRecord(ctx,row);i++;
  if(i%32===0){stageEmit(ctx,'校验 JSONL 日志',moved+i,progressTotal);await new Promise<void>(resolve=>setImmediate(resolve));}
 }
 stageEmit(ctx,'校验 JSONL 日志',moved+rows.length,progressTotal);
 if(outputFiles.length){
  // Preserve files that have no matching operation ID, including orphan batch sub-operation files.
  const known=(ctx.db.prepare("SELECT id,record_path FROM activity WHERE record_path IS NOT NULL").all() as {id:string;record_path:string}[]);
  const byLegacyName=new Map(known.map(row=>[row.id.replace(/[^a-zA-Z0-9_.-]/g,'_'),row.record_path]));
  const groups=new Map<string,Map<string,string>>();
  for(const file of outputFiles){
   const filename=file.slice(out.length+1).replaceAll('\\','/');
   const match=/^(.+)\.(input\.json|out|err)$/.exec(filename);
   const base=match?.[1]??'unrecognized-'+createHash('sha256').update(filename).digest('hex');
   const stream=match?.[2]==='input.json'?'input':match?.[2]==='out'?'stdout':match?.[2]==='err'?'stderr':'stdout';
   const group=groups.get(base)??new Map<string,string>();group.set(stream,file);groups.set(base,group);
  }
  let processed=0;stageEmit(ctx,'检查旧版输出文件',moved+rows.length,progressTotal);
  for(const [base,files] of groups){
   const relative=byLegacyName.get(base);
   let covered=Boolean(relative);
   if(covered&&relative){
    for(const [type,file] of files){
     if(type==='input')covered=covered&&ctx.journal.getInput(relative)!==null;
     else {
      const actual=ctx.journal.getRecordStream(relative,type as 'stdout'|'stderr',0,1).totalBytes;
      covered=covered&&actual>=statSync(file).size;
     }
     if(!covered)break;
    }
   }
   if(!covered)migrateOrphan(ctx,base,files);
   processed+=files.size;
   if(processed%16<=files.size){stageEmit(ctx,'检查旧版输出文件',moved+rows.length+processed,progressTotal);
    await new Promise<void>(resolve=>setImmediate(resolve));}
  }
  stageEmit(ctx,'检查旧版输出文件',moved+rows.length+outputFiles.length,progressTotal);
  // Each legacy file now has a recoverable journal record. Only then remove the obsolete directory.
  rmSync(out,{recursive:true,force:false,maxRetries:4,retryDelay:100});
  if(existsSync(out))throw Error('LEGACY_OUTPUT_NOT_REMOVED');
 }else stageEmit(ctx,'检查旧版输出文件',moved+rows.length,progressTotal,'无旧文件');
 stageEmit(ctx,'压缩 SQLite 数据库',progressTotal-1,progressTotal);
 ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 ctx.db.exec('VACUUM');
 ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 stageEmit(ctx,'压缩 SQLite 数据库',progressTotal,progressTotal);
}
const migrations:Step[]=[{version:'0.2.0',run:migrateTo020}];
export function migrationRequired(root=dataDir,target=codeVersion()):boolean{
 const file=join(root,'state.sqlite');if(!existsSync(file))return false;
 const db=new DatabaseSync(file,{readOnly:true});
 try{const difference=cmp(storedVersion(db),target);if(difference>0)throw Error('STORAGE_FROM_NEWER_VERSION');return difference<0;}finally{db.close();}
}
export async function runStorageMigrations(options:{root?:string;target?:string;onProgress?:(p:MigrationProgress)=>void}={}):Promise<MigrationResult>{
 const root=options.root??dataDir,target=options.target??codeVersion();
 mkdirSync(root,{recursive:true,mode:0o700});
 const lock=join(root,migrationLock);
 let fd:number|undefined;
 for(let attempt=0;attempt<3;attempt++){
  try{fd=openSync(lock,'wx',0o600);break;}
  catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   let alive=false;
   try{const existing=JSON.parse(readFileSync(lock,'utf8')) as {pid:number};
    if(Number.isSafeInteger(existing.pid)&&existing.pid>0){try{process.kill(existing.pid,0);alive=true;}catch(error){
      alive=(error as NodeJS.ErrnoException).code==='EPERM';
    }}
   }catch{}
   if(alive)throw Error('MIGRATION_ALREADY_RUNNING: '+lock);
   try{if(Date.now()-statSync(lock).mtimeMs<5000)throw Error('MIGRATION_LOCK_BUSY: '+lock);}catch(error){if((error as Error).message.startsWith('MIGRATION_LOCK_BUSY'))throw error;}
   rmSync(lock,{force:true});
  }
 }
 if(fd===undefined)throw Error('MIGRATION_LOCK_UNAVAILABLE');
 const started=Date.now();
 const logMigration=(name:string,level:'info'|'warn'|'error',fields:Record<string,unknown>)=>{
  if(resolve(root)===resolve(diagnosticDataDir))logEvent('migration',name,level,fields);
 };
 let db:DatabaseSync|undefined;
 try{
  writeSync(fd,JSON.stringify({pid:process.pid,startedAt:started}));
  db=new DatabaseSync(join(root,'state.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  const initial=storedVersion(db);if(cmp(initial,target)>0)throw Error('STORAGE_FROM_NEWER_VERSION: '+initial+' > '+target);
  logMigration('upgrade.started','info',{from:initial,to:target});
  const executed:string[]=[];
  let last=initial;
  const journal=new RecordJournal(join(root,'records'));
  for(const step of migrations){
   if(cmp(step.version,last)<=0||cmp(step.version,target)>0)continue;
   const stepStarted=Date.now(),loggedBuckets=new Set<number>();
   logMigration('step.started','info',{from:last,to:step.version});
   const emit=(stage:string,completed:number,total:number,detail?:string)=>{
    const progress=Math.max(0,Math.min(1,total?completed/total:1));
    const elapsedMs=Date.now()-stepStarted;
    const etaMs=completed>0&&completed<total?Math.round(elapsedMs/completed*(total-completed)):null;
    const bucket=Math.floor(progress*10);
    if(!loggedBuckets.has(bucket)){
      loggedBuckets.add(bucket);
      logMigration('step.progress','info',{stage,from:last,to:step.version,percent:Math.floor(progress*100),completed,total,etaMs});
    }
    options.onProgress?.({stage,from:last,to:step.version,completed,total,percent:Math.floor(progress*100),elapsedMs,etaMs,detail});
   };
   await step.run({db,journal,root,emit});
   putVersion(db,step.version);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');last=step.version;executed.push(step.version);
   logMigration('step.completed','info',{version:step.version,durationMs:Date.now()-stepStarted});
   emit('已完成 '+step.version+' 升级',1,1);
  }
  if(cmp(last,target)<0){putVersion(db,target);last=target;}
  db.close();db=undefined;
  logMigration('upgrade.completed','info',{from:initial,to:last,steps:executed,durationMs:Date.now()-started});
  return{from:initial,to:last,steps:executed,changed:cmp(initial,last)<0,removedOldOutput:!existsSync(join(root,'output'))};
 }catch(error){logMigration('upgrade.failed','error',{error,durationMs:Date.now()-started});throw error;}
 finally{try{db?.close();}catch{}try{closeSync(fd!);}catch{}rmSync(lock,{force:true});}
}
