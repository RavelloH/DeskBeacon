import {existsSync,openSync,closeSync,readSync,readFileSync,renameSync,statSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {RecordJournal,recordRelativePath} from './record-journal.js';

type LegacyRow={id:string;tool:string|null;status:string|null;time:number|null;request_json:string|null;result:string|null;
 receipt_result:string|null;receipt_status:string|null};
export type MigrationReport={migrated:number;recovered:number;incomplete:number;errors:number};
function parse(value:string|null):unknown{
 if(value===null)return null;
 try{return JSON.parse(value);}catch{return{legacyRaw:value,legacyPartial:true};}
}
function legacyFile(outputDir:string,path:string|undefined|null):string|null{
 if(!path)return null;
 const full=resolve(path),root=resolve(outputDir);
 return(full.startsWith(root+sep)&&existsSync(full))?full:null;
}
function legacySafeId(id:string):string{return id.replace(/[^a-zA-Z0-9_.-]/g,'_');}
function readOldInput(outputDir:string,row:LegacyRow):{value:unknown;partial:boolean}{
 const file=join(outputDir,legacySafeId(row.id)+'.input.json');
 if(existsSync(file)){
  try{
   if(statSync(file).size<=32*1024*1024)return{value:parse(readFileSync(file,'utf8')),partial:false};
   return{value:{summary:'Legacy input exceeded migration safety limit',legacyPartial:true},partial:true};
  }catch{}
 }
 return{value:parse(row.request_json),partial:true};
}
async function copyOldStream(journal:RecordJournal,id:string,stream:'stdout'|'stderr',path:string|null):Promise<boolean>{
 if(!path)return false;
 const fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(64*1024);
 try{for(;;){const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;journal.stream(id,stream,chunk.subarray(0,n));}}
 finally{closeSync(fd);}
 return true;
}
function commitMigration(db:DatabaseSync,row:LegacyRow,relative:string,partial:boolean):void{
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('UPDATE activity SET record_path=?,record_state=?,request_json=NULL,result=NULL WHERE id=?')
    .run(relative,partial?'legacy_partial':'ready',row.id);
  db.prepare('UPDATE receipts SET result=NULL WHERE id=?').run(row.id);
  db.prepare('UPDATE background SET record_path=?,stdout_path=NULL,stderr_path=NULL WHERE operation_id=?')
    .run(relative,row.id);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
async function migrateBatchChildren(db:DatabaseSync,journal:RecordJournal,outputDir:string,row:LegacyRow,
 input:unknown,parentResult:unknown):Promise<boolean>{
 if(!input||typeof input!=='object')return true;
 const stages=Array.isArray((input as any).stages)?(input as any).stages:[];
 const resultStages=Array.isArray((parentResult as any)?.stages)?(parentResult as any).stages:[];
 let partial=false;
 for(const stage of stages){
  for(const call of (Array.isArray(stage.calls)?stage.calls:[])){
   if(typeof call.id!=='string'||typeof call.tool!=='string'){partial=true;continue;}
   const childId=row.id+':'+call.id,childTime=Number(row.time??Date.now()),ref=recordRelativePath(childId,childTime);
   const found=resultStages.flatMap((item:any)=>Array.isArray(item.results)?item.results:[]).find((item:any)=>item.id===call.id);
   const childResult=found?.result?.data??found?.result??(found?.error?{error:found.error}:{legacyMissingResult:true});
   if(!journal.exists(ref)||!journal.getResult(ref)){
    if(journal.exists(ref))renameSync(journal.path(ref),journal.path(ref)+'.interrupted-'+Date.now());
    journal.start(childId,call.tool,call.input??{}, {time:childTime,parentOperationId:row.id});
    try{
     const out=legacyFile(outputDir,join(outputDir,legacySafeId(childId)+'.out'));
     const err=legacyFile(outputDir,join(outputDir,legacySafeId(childId)+'.err'));
     if(out)await copyOldStream(journal,childId,'stdout',out);
     if(err)await copyOldStream(journal,childId,'stderr',err);
     journal.finish(childId,childResult,found?.ok===false?'failed':'completed');
    }catch(e){journal.close(childId);throw e;}
   }
   journal.linkChild(row.id,childId,ref,call.tool);
   if(found?.truncated||!found)partial=true;
   db.prepare('UPDATE background SET record_path=? WHERE id=?').run(ref,childId);
  }
 }
 return partial;
}

async function migrateOne(db:DatabaseSync,journal:RecordJournal,dataDir:string,row:LegacyRow):Promise<'migrated'|'recovered'|'incomplete'>{
 const relative=recordRelativePath(row.id,Number(row.time??Date.now()));
 if(journal.exists(relative)){
  const result=journal.getResult(relative);
  if(result?.hasResult&&journal.getInput(relative)!==null){
   commitMigration(db,row,relative,true);
   return 'recovered';
  }
  renameSync(journal.path(relative),journal.path(relative)+'.interrupted-'+Date.now());
 }
 const outputDir=join(dataDir,'output'),input=readOldInput(outputDir,row);
 const receipt=parse(row.receipt_result),fallback=parse(row.result);
 const result=receipt??fallback??{legacyMissingResult:true,legacyStatus:row.status};
 let partial=input.partial||row.receipt_result===null;
 journal.start(row.id,row.tool??'unknown',input.value,{time:Number(row.time??Date.now())});
 try{
  const legacyId=legacySafeId(row.id);
  const bg=db.prepare('SELECT stdout_path,stderr_path,exit_code,status FROM background WHERE operation_id=? LIMIT 1')
    .get(row.id) as {stdout_path:string|null;stderr_path:string|null;exit_code:number|null;status:string|null}|undefined;
  if(row.tool==='exec_foreground'||row.tool==='exec_background'||row.tool==='exec_batch'||row.id.includes(':')){
   const out=legacyFile(outputDir,bg?.stdout_path??join(outputDir,legacyId+'.out'));
   const err=legacyFile(outputDir,bg?.stderr_path??join(outputDir,legacyId+'.err'));
   const hasOut=await copyOldStream(journal,row.id,'stdout',out);
   const hasErr=await copyOldStream(journal,row.id,'stderr',err);
   const record=result as Record<string,unknown>;
   if(!hasOut&&typeof record.stdout==='string')journal.stream(row.id,'stdout',Buffer.from(record.stdout));
   if(!hasErr&&typeof record.stderr==='string')journal.stream(row.id,'stderr',Buffer.from(record.stderr));
  }
  if(row.tool==='batch')partial=(await migrateBatchChildren(db,journal,outputDir,row,input.value,result))||partial;
  const status=row.receipt_status==='failed'||row.status==='failed'?'failed':'completed';
  journal.finish(row.id,result,status,{background:row.tool==='exec_background'});
  if(row.tool==='exec_background')journal.processExit(row.id,bg?.exit_code??null);
  commitMigration(db,row,relative,partial);
  return partial?'incomplete':'migrated';
 }catch(e){journal.close(row.id);throw e;}
}
/** Runs only when the real Runtime has acquired its exclusive IPC/DB lock.
 * Each row is independently atomic on the DB side, retryable across restarts.
 * Existing legacy data are left untouched until successful verification. */
export async function migrateLegacyRecords(db:DatabaseSync,journal:RecordJournal,dataDir:string,
 onProgress?:(batch:number)=>void,shouldStop?:()=>boolean):Promise<MigrationReport>{
 const report:MigrationReport={migrated:0,recovered:0,incomplete:0,errors:0};
 for(;;){
  if(shouldStop?.())break;
  const rows=db.prepare('SELECT a.id,a.tool,a.status,a.time,a.request_json,a.result, '+
    'r.result receipt_result,r.status receipt_status '+
    'FROM activity a LEFT JOIN receipts r ON r.id=a.id '+
    'WHERE a.record_path IS NULL AND (a.request_json IS NOT NULL OR a.result IS NOT NULL OR r.result IS NOT NULL) '+
    "AND (a.record_state IS NULL OR a.record_state<>'migration_error') "+
    'ORDER BY a.time,a.id LIMIT 8').all() as LegacyRow[];
  if(!rows.length)break;
  for(const row of rows){
   if(shouldStop?.())break;
   try{const outcome=await migrateOne(db,journal,dataDir,row);report[outcome]++;}
   catch(e){
    report.errors++;
    db.prepare("UPDATE activity SET record_state='migration_error' WHERE id=?").run(row.id);
    console.error('Legacy record migration failed:',row.id,e instanceof Error?e.message:String(e));
   }
  }
  onProgress?.(rows.length);
  await new Promise<void>(resolve=>setTimeout(resolve,25));
 }
 return report;
}
