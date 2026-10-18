import assert from 'node:assert/strict';
import {TOOL_NAMES} from '../../../packages/protocol/dist/tools.js';
import {toolRow,TOOL_LABELS} from '../dist/tool-presentation.js';
import {detailPresentation,wrapDetail} from '../dist/detail-presentation.js';
import {activityTime,dateDivider,tableColumns,rightFit,paneLayout} from '../dist/tui-layout.js';

const make=(tool,req={},res={},status='completed',description='测试操作')=>({
 id:'test-'+tool,grant_id:'grant',actor_name:'Codex',tool,description,
 status,time:Date.now()-2500,finished_at:Date.now(),duration_ms:2500,cwd:'E:/DeskBeacon',
 request_json:JSON.stringify(req),result:JSON.stringify(res)
});
assert.equal(TOOL_NAMES.length,35);
for(const tool of TOOL_NAMES){
 const view=toolRow(make(tool));
 assert.ok(view.toolLabel.length>=2,tool+': missing tool label');
 assert.ok(view.action.length&&view.result.length,tool+': missing segments');
 assert.ok(view.action.every(segment=>typeof segment.text==='string'&&segment.text.length),tool+': invalid action');
 assert.ok(view.result.every(segment=>typeof segment.text==='string'&&segment.text.length),tool+': invalid result');
 assert.ok(!JSON.stringify(view).includes('undefined'),tool+': placeholder leaked');
 assert.ok(TOOL_LABELS[tool],tool+': missing label mapping');
}
console.log('PASS all 35 MCP tools have explicit ACTION / RESULT templates');

const command=make('exec_foreground',{command:{mode:'program',program:'pnpm',args:['test']}},{
 exitCode:0,stdout:'Starting tests...\n12 tests passed\n',durationMs:1900},'completed','执行 TypeScript 类型检查');
const model=toolRow(command);
assert.match(model.action[0].text,/TypeScript/);
assert.equal(model.result[0].text,'12 tests passed');
assert.ok(!JSON.stringify(model.result).includes('1.9s'));
assert.equal(model.result[0].tone,'muted');
const failing=toolRow(make('exec_foreground',{}, {exitCode:1,stderr:'BUILD_FAILED: TS2322\n'},'completed','失败构建'));
assert.match(failing.result[0].text,/退出 1.*TS2322/);
assert.equal(failing.result[0].tone,'danger');
const edited=toolRow(make('fs_edit',{path:'src/a.ts',mode:'replace'}, {changed:true,replacements:2,addedLines:8,removedLines:3}));
assert.deepEqual(edited.result.filter(s=>s.tone==='success'||s.tone==='danger').map(s=>s.text),['+8 行','−3 行']);
assert.match(edited.action[0].text,/a.ts/);
console.log('PASS command stdout preview replaces redundant duration and file diff uses colored line deltas');

const sensitive=toolRow(make('http_request',{method:'GET',url:'https://user:pass@api.example.com/private?token=secret#section'},{status:200}));
assert.ok(!JSON.stringify(sensitive).includes('secret'));
assert.ok(!JSON.stringify(sensitive).includes('pass'));
const shell=toolRow(make('exec_foreground',{command:{mode:'shell',script:'echo --token=supersecret'}}));
assert.ok(!JSON.stringify(shell).includes('supersecret'));
const interrupted=toolRow(make('exec_foreground',{}, {},'interrupted'));
assert.match(interrupted.result[0].text,/结果未知/);
const detail=detailPresentation(edited==='bad'?command:command,Date.now());
assert.ok(detail.some(line=>line.text.includes('OVERVIEW')));
assert.ok(detail.some(line=>line.text.includes('ACTION')));
assert.ok(detail.some(line=>line.text.includes('RESULT')));
assert.ok(wrapDetail(detail,30).every(line=>typeof line.text==='string'));
console.log('PASS secrets are hidden and detail sections handle interruptions');

const today=Date.now(),yesterday=today-86400000*2;
assert.match(activityTime(today,today),/^\d\d:\d\d:\d\d$/);
assert.ok(activityTime(yesterday,today).includes('-'));
assert.equal(rightFit('5s',6),'    5s');
assert.ok(tableColumns(130).some(c=>c.title==='TOOL'));
assert.ok(tableColumns(130).some(c=>c.title==='ACTION'));
assert.ok(tableColumns(130).some(c=>c.title==='RESULT'));
assert.ok(paneLayout(130,28).activityWidth>paneLayout(130,28).detailWidth);
console.log('PASS adaptive time, TOOl label, right-aligned duration and wider activity pane');
