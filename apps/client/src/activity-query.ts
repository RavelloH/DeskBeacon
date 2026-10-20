import type {DatabaseSync} from 'node:sqlite';

/** Page complete rows, so the list and detail pane share one consistent record. */
export const ACTIVITY_PAGE_SIZE=50;
const baseColumns=['id','grant_id','actor_name','tool','description','status','time','finished_at','duration_ms','cwd','record_path','record_state','outcome','exit_code','error_code','request_json','result'];
const rank="CASE WHEN status='running' THEN 1 ELSE 0 END";
export type ActivityCursor={running:0|1;time:number;id:string};
export type ActivityPageOptions={cursor?:string;query?:string;limit?:number;watchIds?:string[];searchIds?:string[]};
export type ActivityDayStats={date:string;total:number;success:number;failed:number;interrupted:number;running:number};
export type ActivityPage={rows:Record<string,any>[];nextCursor:string|null;hasMore:boolean;total:number;updates:Record<string,any>[];days:ActivityDayStats[]};
/** Older running services do not return days; new TUI must remain usable until restart. */
export function compatibleDayStats(value:unknown):ActivityDayStats[]|null{
 if(!Array.isArray(value))return null;
 if(!value.every(d=>d&&typeof d==='object'&&typeof d.date==='string'&&
  ['total','success','failed','interrupted','running'].every(key=>
   Number.isSafeInteger(d[key])&&d[key]>=0)))return null;
 return value as ActivityDayStats[];
}

function decode(value:string):ActivityCursor{
 try{
  const data=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as ActivityCursor;
  if((data.running!==0&&data.running!==1)||!Number.isSafeInteger(data.time)||
   typeof data.id!=='string'||!data.id||data.id.length>128)throw Error();
  return data;
 }catch{throw Error('INVALID_ACTIVITY_CURSOR');}
}
function searchClause(query:string,searchIds:string[]=[]){
 const term=query.trim().toLowerCase();
 if(!term)return {where:'',args:[] as string[]};
 const fields=['tool','description','actor_name','grant_id','cwd','status','request_json','result'];
 const ids=searchIds.slice(0,1000);
 return {where:'('+fields.map(field=>"instr(lower(coalesce("+field+",'')), ?) > 0").join(' OR ')+
   (ids.length?' OR id IN ('+ids.map(()=>'?').join(',')+')':'')+')',
  args:[...fields.map(()=>term),...ids]};
}
export function sortActivityRows<T extends {id:string;status:string;time:number}>(rows:T[]):T[]{
 return [...rows].sort((a,b)=>Number(b.status==='running')-Number(a.status==='running')||b.time-a.time||b.id.localeCompare(a.id));
}
export function activityPage(db:DatabaseSync,opts:ActivityPageOptions={}):ActivityPage{
 const limit=Number.isInteger(opts.limit)?Math.max(1,Math.min(100,opts.limit!)):ACTIVITY_PAGE_SIZE;
 if(opts.cursor && (typeof opts.cursor!=='string'||opts.cursor.length>1024))throw Error('INVALID_ACTIVITY_CURSOR');
 if(opts.query!==undefined && (typeof opts.query!=='string'||opts.query.length>256))throw Error('INVALID_ACTIVITY_QUERY');
 const available=new Set((db.prepare('PRAGMA table_info(activity)').all() as {name:string}[]).map(v=>v.name));
 const columns=baseColumns.map(name=>available.has(name)?name:'NULL AS '+name).join(',');
 const search=searchClause(opts.query??'',opts.searchIds??[]),clauses:string[]=[],args:(string|number)[]=[];
 if(search.where){clauses.push(search.where);args.push(...search.args);}
 if(opts.cursor){
  const cursor=decode(opts.cursor);
  clauses.push('('+rank+' < ? OR ('+rank+' = ? AND (time < ? OR (time = ? AND id < ?))))');
  args.push(cursor.running,cursor.running,cursor.time,cursor.time,cursor.id);
 }
 const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
 const found=db.prepare('SELECT '+columns+' FROM activity'+where+
  ' ORDER BY '+rank+' DESC,time DESC,id DESC LIMIT ?').all(...args,limit+1) as Record<string,any>[];
 const hasMore=found.length>limit,rows=found.slice(0,limit),last=rows.at(-1);
 const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({running:last.status==='running'?1:0,
  time:last.time,id:last.id})).toString('base64url'):null;
 // Aggregate the entire matching database, not the currently loaded cursor page.
 // SQLite's localtime modifier follows the same local calendar date as the TUI.
 // A completed command may still have a nonzero exit code or structured error.
 // Mirror the presentation's failure semantics, rather than counting only status='failed'.
 const classified=`CASE
  ${available.has('outcome')?"WHEN outcome IN ('success','failed','running','interrupted') THEN outcome":''}
  WHEN status='failed' THEN 'failed'
  WHEN status IN ('interrupted','cancelled','stopped') THEN 'interrupted'
  WHEN status IN ('running','accepted','started') THEN 'running'
  WHEN status='completed' AND json_valid(result) THEN
   CASE WHEN CAST(COALESCE(json_extract(result,'$.exitCode'),json_extract(result,'$.data.exitCode'),0) AS INTEGER)<>0
    OR json_extract(result,'$.error') IS NOT NULL
    OR json_extract(result,'$.data.error') IS NOT NULL
    OR json_extract(result,'$.isError')=1
    OR json_extract(result,'$.timedOut')=1
    OR json_extract(result,'$.spawnError') IS NOT NULL AND json_extract(result,'$.spawnError')<>''
    OR COALESCE(json_extract(result,'$.failureCount'),json_extract(result,'$.failed'),0)>0
   THEN 'failed' ELSE 'success' END
  WHEN status='completed' THEN 'success'
  ELSE 'interrupted' END`;
 const days=db.prepare('WITH states AS (SELECT strftime(\'%Y-%m-%d\',time/1000,\'unixepoch\',\'localtime\') AS date,'+
  classified+' AS category FROM activity'+(search.where?' WHERE '+search.where:'')+
  `) SELECT date,COUNT(*) AS total,
  SUM(CASE WHEN category='success' THEN 1 ELSE 0 END) AS success,
  SUM(CASE WHEN category='failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN category='interrupted' THEN 1 ELSE 0 END) AS interrupted,
  SUM(CASE WHEN category='running' THEN 1 ELSE 0 END) AS running
  FROM states GROUP BY date ORDER BY date DESC`).all(...search.args) as unknown as ActivityDayStats[];
 const total=days.reduce((sum,day)=>sum+Number(day.total),0);
 const ids=opts.watchIds??[];
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>128||!id))throw Error('INVALID_ACTIVITY_WATCH');
 const updates=ids.length?db.prepare('SELECT '+columns+' FROM activity WHERE id IN ('+ids.map(()=>'?').join(',')+')').all(...ids) as Record<string,any>[]:[];
 return {rows,nextCursor,hasMore,total,updates,days};
}
