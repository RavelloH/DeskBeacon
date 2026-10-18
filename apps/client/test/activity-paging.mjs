import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {activityPage,sortActivityRows,compatibleDayStats} from '../dist/activity-query.js';
import {activityPresentation,detailLines} from '../dist/presenter.js';

const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE activity (id TEXT PRIMARY KEY,grant_id TEXT,actor_name TEXT,tool TEXT,description TEXT,status TEXT,time INTEGER,finished_at INTEGER,duration_ms INTEGER,cwd TEXT,request_json TEXT,result TEXT)');
const insert=db.prepare('INSERT INTO activity (id,grant_id,actor_name,tool,description,status,time,finished_at,duration_ms,cwd,request_json,result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
try{
 for(let i=0;i<173;i++){
  const running=i===5||i===10;
  insert.run('op-'+String(i).padStart(3,'0'),'grant-1',i%2?'ChatGPT':'Codex',
   'exec_foreground',i===110?'Build special-old-module':'运行测试',
   running?'running':'completed',1_700_000_000_000+Math.floor(i/2)*1000,
   running?null:1_700_000_000_000+Math.floor(i/2)*1000+250,running?null:250,
   'E:/DeskBeacon',
   JSON.stringify({command:{mode:'program',program:'pnpm',args:[i===160?'deep-search-in-arguments':'check']}}),
   JSON.stringify({exitCode:i===110?2:0,stdout:i===110?'BUILD_FAILED':'PASS',durationMs:250}));
 }
 let cursor,rows=[],pageCount=0,firstPage;
 do{
  const page=activityPage(db,{cursor,limit:50});
  if(!firstPage)firstPage=page;
  assert.ok(page.rows.length<=50,'the database must only return one bounded page');
  assert.equal(page.total,173);
  assert.equal(page.days.reduce((n,d)=>n+d.total,0),173,'day aggregates must include all 173 rows, not only the current 50');
  assert.equal(page.days.reduce((n,d)=>n+d.failed,0),1,'nonzero exit code is a failed operation even when persisted as completed');
  assert.equal(page.days.reduce((n,d)=>n+d.running,0),2);
  assert.equal(page.updates.length,0);
  rows.push(...page.rows);
  cursor=page.nextCursor??undefined;
  if(cursor)assert.equal(page.hasMore,true);
  else assert.equal(page.hasMore,false);
  pageCount++;
  assert.ok(pageCount<10,'pagination must converge');
 }while(cursor);
 assert.equal(pageCount,4);
 assert.equal(rows.length,173);
 assert.equal(new Set(rows.map(r=>r.id)).size,173,'paging must not duplicate or skip rows sharing a timestamp');
 assert.deepEqual(rows.slice(0,2).map(r=>r.id),['op-010','op-005'],'running tasks must stay ahead of history');
 assert.deepEqual(rows.map(r=>r.id),sortActivityRows(rows).map(r=>r.id));
 const failing=rows.find(r=>r.id==='op-110');
 const model=activityPresentation(failing,Date.now());
 assert.equal(model.state,'failed','nonzero process exit must be visible without a detail query');
 assert.equal(model.target,'pnpm check','TARGET must use input JSON');
 assert.equal(model.intent,'Build special-old-module','INTENT must use description');
 assert.match(model.summary,/退出码 2/,'RESULT must be visible on the list');
 assert.ok(detailLines(failing).some(line=>line.includes('BUILD_FAILED')),
  'details must be available directly from the page record');

 assert.equal(compatibleDayStats(undefined),null,'old IPC pages without days must fall back, not throw');
 assert.equal(compatibleDayStats({}),null);
 assert.equal(compatibleDayStats([{date:'bad',total:3}]),null,'incomplete aggregation cannot masquerade as full');
 assert.deepEqual(compatibleDayStats(firstPage.days),firstPage.days);
 console.log('PASS new TUI safely accepts legacy Runtime pages without the days field');
 const filtered=activityPage(db,{query:'special-old-module'});
 assert.equal(filtered.total,1,'search must find old records outside the initial page');
 assert.equal(filtered.rows[0].id,'op-110');
 const inputSearch=activityPage(db,{query:'deep-search-in-arguments'});
 assert.equal(inputSearch.total,1,'search must inspect stored request_json');
 assert.equal(inputSearch.rows[0].id,'op-160');
 const byAgent=activityPage(db,{query:'Codex',limit:6});
 assert.equal(byAgent.rows.length,6);
 assert.equal(byAgent.total,87);
 const wildcard=activityPage(db,{query:'%'});
 assert.equal(wildcard.total,0,'search is literal, not SQL LIKE wildcard syntax');
 const watch=activityPage(db,{limit:3,watchIds:['op-110']});
 assert.equal(watch.updates.length,1);
 assert.equal(watch.updates[0].id,'op-110');
 assert.throws(()=>activityPage(db,{cursor:'broken'}),/INVALID_ACTIVITY_CURSOR/);
 assert.throws(()=>activityPage(db,{query:'x'.repeat(257)}),/INVALID_ACTIVITY_QUERY/);
 assert.throws(()=>activityPage(db,{watchIds:Array.from({length:101},()=> 'x')}),/INVALID_ACTIVITY_WATCH/);
 console.log('PASS SQLite full-record keyset paging 173 rows / four pages, running-first order and duplicate timestamps');
 console.log('PASS immediate TARGET, INTENT, failed RESULT and detail content from the same page');
 console.log('PASS database-wide search, watch updates, bounded limits and input validation');
}finally{db.close();}
