import type {DatabaseSync} from 'node:sqlite';

/** Page complete rows, so the list and detail pane share one consistent record. */
export const ACTIVITY_PAGE_SIZE=50;
const columns='id,grant_id,actor_name,tool,description,status,time,finished_at,duration_ms,cwd,request_json,result';
const rank="CASE WHEN status='running' THEN 1 ELSE 0 END";
export type ActivityCursor={running:0|1;time:number;id:string};
export type ActivityPageOptions={cursor?:string;query?:string;limit?:number;watchIds?:string[]};
export type ActivityPage={rows:Record<string,any>[];nextCursor:string|null;hasMore:boolean;total:number;updates:Record<string,any>[]};

function decode(value:string):ActivityCursor{
 try{
  const data=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as ActivityCursor;
  if((data.running!==0&&data.running!==1)||!Number.isSafeInteger(data.time)||
   typeof data.id!=='string'||!data.id||data.id.length>128)throw Error();
  return data;
 }catch{throw Error('INVALID_ACTIVITY_CURSOR');}
}
function searchClause(query:string){
 const term=query.trim().toLowerCase();
 if(!term)return {where:'',args:[] as string[]};
 const fields=['tool','description','actor_name','grant_id','cwd','request_json','result','status'];
 return {where:'('+fields.map(field=>"instr(lower(coalesce("+field+",'')), ?) > 0").join(' OR ')+')',
  args:fields.map(()=>term)};
}
export function sortActivityRows<T extends {id:string;status:string;time:number}>(rows:T[]):T[]{
 return [...rows].sort((a,b)=>Number(b.status==='running')-Number(a.status==='running')||b.time-a.time||b.id.localeCompare(a.id));
}
export function activityPage(db:DatabaseSync,opts:ActivityPageOptions={}):ActivityPage{
 const limit=Number.isInteger(opts.limit)?Math.max(1,Math.min(100,opts.limit!)):ACTIVITY_PAGE_SIZE;
 if(opts.cursor && (typeof opts.cursor!=='string'||opts.cursor.length>1024))throw Error('INVALID_ACTIVITY_CURSOR');
 if(opts.query!==undefined && (typeof opts.query!=='string'||opts.query.length>256))throw Error('INVALID_ACTIVITY_QUERY');
 const search=searchClause(opts.query??''),clauses:string[]=[],args:(string|number)[]=[];
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
 const total=Number((db.prepare('SELECT COUNT(*) AS count FROM activity'+(search.where?' WHERE '+search.where:'')).get(...search.args) as {count:number}).count);
 const ids=opts.watchIds??[];
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>128||!id))throw Error('INVALID_ACTIVITY_WATCH');
 const updates=ids.length?db.prepare('SELECT '+columns+' FROM activity WHERE id IN ('+ids.map(()=>'?').join(',')+')').all(...ids) as Record<string,any>[]:[];
 return {rows,nextCursor,hasMore,total,updates};
}
