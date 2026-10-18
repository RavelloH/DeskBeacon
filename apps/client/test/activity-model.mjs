import assert from 'node:assert/strict';
import {activityPresentation,detailLines} from '../dist/presenter.js';

const now=1_800_000_000_000;
function entry(overrides={}){
 return {
  id:'op-1',grant_id:'a13ff7cf-9d11-4acb',actor_name:'  ChatGPT  ',tool:'exec_foreground',
  description:'运行全量测试',status:'completed',time:now-170,finished_at:now,duration_ms:170,
  cwd:'E:\\DeskBeacon',request_json:JSON.stringify({command:{mode:'program',program:'pnpm',args:['--filter','@deskbeacon/server','test --watch']}}),
  result:JSON.stringify({exitCode:0,stdout:'PASS all tests\n',stderr:'',durationMs:170}),...overrides
 };
}

let view=activityPresentation(entry(),now);
assert.deepEqual(view,{agent:'ChatGPT',tool:'执行',state:'success',symbol:'✓',status:'成功',
 target:'pnpm --filter @deskbeacon/server "test --watch"',intent:'运行全量测试',
 summary:'退出码 0 · 170ms',elapsed:'170ms',command:'pnpm --filter @deskbeacon/server "test --watch"'});
assert.ok(detailLines(entry()).some(line=>line.includes('stdout · 15 B')));
assert.ok(detailLines(entry()).some(line=>line.includes('stderr · 0 B · 空')));
assert.ok(detailLines(entry()).some(line=>line.startsWith('命令预览：')));
assert.ok(!detailLines(entry({status:'running',result:'{}'})).some(line=>line.includes('已完成')));
assert.ok(detailLines(entry()).includes('PASS all tests'));

// The daemon persists non-zero process exits as `completed`; the result decides the row state.
view=activityPresentation(entry({duration_ms:null,result:JSON.stringify({exitCode:2,stderr:'测试失败',durationMs:12_400})}),now);
assert.equal(view.state,'failed');
assert.equal(view.status,'退出码 2');
assert.equal(view.elapsed,'12.4s');
assert.match(view.summary,/退出码 2/);
assert.ok(detailLines(entry({result:JSON.stringify({exitCode:2,stderr:'测试失败'})})).some(line=>line==='测试失败'));

for(const result of [
 {timedOut:true,exitCode:null},
 {outputLimit:true,exitCode:null},
 {spawnError:'SPAWN_FAILED: missing'},
])assert.equal(activityPresentation(entry({result:JSON.stringify(result)}),now).state,'failed');
assert.equal(activityPresentation(entry({status:'failed',result:JSON.stringify({error:'TOOL_FAILURE'})}),now).state,'failed');
assert.equal(activityPresentation(entry({status:'completed',result:JSON.stringify({cancelled:true,exitCode:1})}),now).state,'stopped',
 'explicit cancellation takes precedence over a non-zero process exit');
assert.equal(activityPresentation(entry({status:'running',duration_ms:null,finished_at:null,time:now-201,result:'{}'}),now).elapsed,'201ms');
assert.equal(activityPresentation(entry({duration_ms:201_000}),now).elapsed,'3m21s');
assert.equal(activityPresentation(entry({actor_name:'  ',grant_id:'a13ff7cf-9d11'}),now).agent,'Agent a13ff7cf');

const http=entry({tool:'http_request',request_json:JSON.stringify({method:'POST',url:'https://user:pass@api.example.test/v1/check?token=TOP_SECRET#section',headers:{Authorization:'AUTH_SECRET'},body:'BODY_SECRET'}),result:JSON.stringify({status:201,ok:true,durationMs:31,body:'RESPONSE_BODY_SECRET'})});
view=activityPresentation(http,now);
assert.equal(view.tool,'请求');
assert.match(view.target,/POST https:\/\/api\.example\.test\/v1\/check/);
assert.doesNotMatch(view.target,/TOP_SECRET|user|pass|section/);
assert.match(view.summary,/HTTP 201/);
const httpDetails=detailLines(http).join('\n');
for(const secret of ['TOP_SECRET','AUTH_SECRET','BODY_SECRET','RESPONSE_BODY_SECRET'])assert.ok(!httpDetails.includes(secret));
assert.match(httpDetails,/请求头：已隐藏/);
assert.match(httpDetails,/请求正文：已隐藏/);

const many=entry({tool:'fs_read_many',request_json:JSON.stringify({files:[{path:'src/main.ts',content:'REQUEST_FILE_SECRET'},{path:'README.md'}]}),
 result:JSON.stringify({files:[{path:'src/main.ts',content:'RESULT_FILE_SECRET',readBytes:2048},{path:'README.md',error:'FILE_NOT_FOUND'}],bytesUsed:2048,successCount:1,failureCount:1})});
view=activityPresentation(many,now);
assert.equal(view.tool,'批量');
assert.match(view.target,/2 个文件 · src\/main\.ts/);
assert.match(view.summary,/1 成功 · 1 失败/);
assert.equal(view.state,'failed');
assert.equal(view.status,'1 项失败');
const manyDetails=detailLines(many).join('\n');
assert.ok(!manyDetails.includes('REQUEST_FILE_SECRET'));
assert.ok(!manyDetails.includes('RESULT_FILE_SECRET'));
assert.match(manyDetails,/src\/main\.ts/);

const batch=entry({tool:'batch',request_json:JSON.stringify({stages:[{parallel:true,calls:[{id:'read',tool:'fs_read',input:{}},{id:'stat',tool:'fs_stat',input:{}}]},{parallel:false,calls:[{id:'check',tool:'exec_foreground',input:{}}]}]}),
 result:JSON.stringify({completed:2,failed:1,skipped:0,stages:[{index:0,results:[{tool:'fs_read',ok:true},{tool:'fs_stat',ok:false,error:{message:'FILE_NOT_FOUND'}}]}]})});
view=activityPresentation(batch,now);
assert.equal(view.target,'3 个调用 · 2 个阶段');
assert.equal(view.state,'failed');
assert.match(view.summary,/2 成功 · 1 失败/);
assert.ok(detailLines(batch).some(line=>line.includes('fs_stat：失败')));

const hidden=entry({tool:'transfer_upload',request_json:JSON.stringify({targetPath:'out.bin',expectedBytes:8,env:{TOKEN:'ENV_TOKEN_SECRET'},content:'CONTENT_SECRET',dataBase64:'BASE64_SECRET',token:'TOKEN_SECRET'}),result:JSON.stringify({writtenBytes:8,dataBase64:'RESULT_BASE64_SECRET'})});
const hiddenView=activityPresentation(hidden,now);
const hiddenDetail=detailLines(hidden).join('\n');
for(const secret of ['ENV_TOKEN_SECRET','CONTENT_SECRET','BASE64_SECRET','TOKEN_SECRET','RESULT_BASE64_SECRET']){
 assert.ok(!JSON.stringify(hiddenView).includes(secret),`row leaked ${secret}`);
 assert.ok(!hiddenDetail.includes(secret),`detail leaked ${secret}`);
}

const allTools=['device_list','device_info','workspace_open','workspace_info','workspace_cd','fs_list','fs_stat','fs_read','fs_read_many','fs_find','fs_grep','fs_write','fs_edit','fs_manage','fs_archive','exec_foreground','batch','exec_background','background_list','background_get','background_output','background_input','background_stop','operation_get','operation_output','transfer_upload','transfer_download','transfer_status','transfer_cancel','net_ports','net_probe','http_request','system_snapshot','system_processes','screen_capture'];
assert.equal(allTools.length,35);
for(const tool of allTools){
 const presentation=activityPresentation(entry({tool,request_json:JSON.stringify({path:'C:\\Work\\file.txt',paths:['a','b'],files:[{path:'first.ts'}],stages:[{calls:[{id:'1',tool:'fs_read'}]}],command:{mode:'shell',script:'Write-Output ok'},mode:'tcp',host:'example.test',port:443,hostname:'example.test',url:'https://example.test/path',backgroundTaskId:'task-1',operationId:'op-2',transferId:'transfer-1',monitor:0})}),now);
 assert.notEqual(presentation.tool,'操作',`missing short tool label for ${tool}`);
 assert.ok(presentation.target.length>0,`missing target for ${tool}`);
}

const controls=activityPresentation(entry({description:'Run\tchecks\nnow\u001b[31m!\u001b[0m',request_json:JSON.stringify({path:'folder\nfile'})}),now);
assert.doesNotMatch(controls.intent,/\r|\n|\u001b/);
assert.doesNotMatch(controls.target,/\r|\n|\u001b/);

const shell=entry({request_json:JSON.stringify({command:{mode:'shell',script:'Write-Output "hello"\nWrite-Output "done"'}})});
assert.match(activityPresentation(shell,now).command,/Write-Output "hello" Write-Output "done"/);
assert.ok(detailLines(shell).some(line=>line.includes('命令脚本预览')));
assert.ok(detailLines(shell).includes('Write-Output "hello"'));
assert.ok(detailLines(shell).includes('Write-Output "done"'));
const sensitiveScript=entry({request_json:JSON.stringify({command:{mode:'shell',script:'TOKEN="SHELL_SECRET"\ncontent="CONTENT_SECRET"'}})});
const sensitiveScriptLines=detailLines(sensitiveScript).join('\n');
assert.ok(!sensitiveScriptLines.includes('SHELL_SECRET'));
assert.ok(!sensitiveScriptLines.includes('CONTENT_SECRET'));
const secretArg=entry({request_json:JSON.stringify({command:{mode:'program',program:'node',args:['inspect.js','--token','FLAG_SECRET','--api-key=API_SECRET']}})});
for(const value of ['FLAG_SECRET','API_SECRET']){
 assert.ok(!JSON.stringify(activityPresentation(secretArg,now)).includes(value));
 assert.ok(!detailLines(secretArg).join('\n').includes(value));
}
const failedProbe=entry({tool:'net_probe',request_json:JSON.stringify({mode:'tcp',host:'127.0.0.1',port:8123}),result:JSON.stringify({mode:'tcp',connected:false,errorCode:'ECONNREFUSED',durationMs:4})});
view=activityPresentation(failedProbe,now);
assert.equal(view.state,'success','a negative probe is a successful diagnostic operation');
assert.match(view.summary,/连接失败/);
const screenshot=entry({tool:'screen_capture',result:JSON.stringify({operationId:'op-2',status:'completed',data:{mimeType:'image/jpeg',width:128,height:90,sizeBytes:512,base64:'SCREEN_SECRET'}})});
view=activityPresentation(screenshot,now);
assert.match(view.summary,/512 B/);
assert.match(view.summary,/128×90/);
assert.ok(!detailLines(screenshot).join('\n').includes('SCREEN_SECRET'));
assert.ok(detailLines(screenshot).includes('图像数据：已隐藏'));
const cappedOutput=entry({result:JSON.stringify({exitCode:0,stdout:'one\ntwo\n',stderr:'',stdoutBytes:900,outputLimit:true})});
const cappedLines=detailLines(cappedOutput).join('\n');
assert.match(cappedLines,/stdout · 900 B/);
assert.match(cappedLines,/按 o 查看本地日志/);
const longOutput=entry({result:JSON.stringify({exitCode:0,stdout:Array.from({length:42},(_,i)=>`line ${i}`).join('\n'),stderr:''})});
assert.ok(detailLines(longOutput).some(line=>line.includes('按 o 查看本地日志')));
assert.equal(activityPresentation(entry({status:'mystery'}),now).state,'unknown');
const live=entry({status:'running',duration_ms:null,finished_at:null,result:'{}'});
const originalNow=Date.now;
try{
 Date.now=()=>1;
 const first=detailLines(live);
 Date.now=()=>999_999_999;
 assert.deepEqual(detailLines(live),first,'detail lines must not read wall-clock time');
 assert.ok(first.some(line=>line.startsWith('状态：进行中')));
}finally{Date.now=originalNow;}
console.log('PASS activity row models, detailed summaries, status derivation, 35 tool targets and sensitive-field hiding');
