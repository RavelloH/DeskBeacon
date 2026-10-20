import assert from 'node:assert/strict';
import {detailPresentation,wrapDetail} from '../dist/detail-presentation.js';
import {batchActivityInput,batchActivityResult} from '../dist/batch-activity.js';

const entry=(request,result,status='completed')=>({
 id:'batch-detail-test',tool:'batch',description:'测试批处理明细',
 status,grant_id:'grant',actor_name:'Codex',time:Date.now()-2200,
 request_json:JSON.stringify(request),result:JSON.stringify(result),cwd:'E:/DeskBeacon',
});

const request={description:'测试批处理明细',deviceId:'fixture',
 stages:[{parallel:true,calls:[
  {id:'build',tool:'exec_foreground',input:{description:'编译应用',command:{mode:'shell',script:'pnpm build',cwd:'E:/DeskBeacon'}}},
  {id:'read',tool:'fs_read',input:{path:'E:/DeskBeacon/README.md'}}
 ]},{parallel:false,calls:[
  {id:'followup',tool:'exec_foreground',input:{description:'后续检查',command:{mode:'program',program:'node',args:['-v']}}}
 ]}]};
const result={completed:1,failed:1,skipped:1,stoppedEarly:true,stages:[
 {index:0,parallel:true,results:[
  {id:'build',tool:'exec_foreground',ok:true,durationMs:1220,
   result:{status:'completed',data:{exitCode:0,stdout:'Build succeeded',durationMs:1200}}},
  {id:'read',tool:'fs_read',ok:false,error:{code:'ENOENT',message:'Not found'},durationMs:10}
 ]}
]};
const detail=detailPresentation(entry(request,result),Date.now());
const text=detail.map(row=>row.text).join('\n');
for(const part of ['STAGE 1','STAGE 2','并行','串行','build','read','followup',
  'pnpm build','README.md','Build succeeded','ENOENT','后续检查']){
 assert.ok(text.includes(part),'missing batch detail: '+part);
}
assert.ok(text.includes('已跳过')||text.includes('未记录结果'));
assert.ok(detail.length>18,'Batch must show more than its call count');
assert.ok(wrapDetail(detail,45).some(row=>row.text.includes('COMMAND')));
console.log('PASS Batch detail shows each command, target, stage, status, error and output');

const large={...request,stages:[{parallel:true,calls:Array.from({length:16},(_,i)=>({
 id:'long-'+i,tool:'exec_foreground',input:{description:'操作 '+i,
 command:{mode:'shell',script:'echo '+('x'.repeat(900))}}
}))}]};
const largeResult={completed:16,failed:0,skipped:0,stages:[{index:0,parallel:true,
 results:Array.from({length:16},(_,i)=>({id:'long-'+i,tool:'exec_foreground',
  ok:true,durationMs:90,result:{status:'completed',data:{exitCode:0,stdout:'Y'.repeat(3000)}}}))}]};
const inJson=batchActivityInput(large,JSON.stringify(large));
const outJson=batchActivityResult(largeResult,JSON.stringify(largeResult));
const parsedInput=JSON.parse(inJson),parsedOutput=JSON.parse(outJson);
assert.equal(parsedInput.stages[0].calls.length,16);
assert.equal(parsedOutput.stages[0].results.length,16);
assert.ok(inJson.length<20000, 'Batch input preview should stay bounded');
assert.ok(outJson.length<25000,'Batch output preview should stay bounded');
assert.ok(!outJson.includes('Y'.repeat(600)),'Never retain unlimited stdout');
const largeDetail=detailPresentation(entry(parsedInput,parsedOutput),Date.now());
const largeText=largeDetail.map(row=>row.text).join('\n');
assert.ok(largeText.includes('long-0')&&largeText.includes('long-15'));
assert.ok(largeText.includes('以上为本地有界摘要'));
console.log('PASS large Batch previews retain all sub-operations rather than collapsing to a count');

const legacy=detailPresentation(entry({description:'old',stages:[]},{summary:'historical truncated'}),Date.now());
assert.ok(legacy.some(row=>row.text.includes('历史摘要未包含子操作')),'Old truncation must be explained');
console.log('PASS legacy incomplete Batch records have a clear full-inspector fallback');
