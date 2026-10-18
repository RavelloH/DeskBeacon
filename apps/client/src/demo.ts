// Pure, deterministic development fixtures. No OAuth, WebSocket, local IPC or filesystem access.
export type DemoScenario = 'connected'|'connecting'|'offline'|'busy'|'failed'|'transfers'|'crowded';
export const demoScenarios:DemoScenario[]=['connected','connecting','offline','busy','failed','transfers','crowded'];
export type DemoActivity={
 id:string;grant_id:string;actor_name:string;tool:string;description:string;status:string;
 time:number;finished_at:number|null;duration_ms:number|null;cwd:string;
 request_json:string;result:string;
};
export type DemoTask={id:string;description:string;start:number;kind:'foreground'|'background';pid:number};
export type DemoTransfer={id:string;status:string;bytes:number;totalBytes:number;path:string;start:number};
export type DemoStatus={
 state:string;deviceName:string;deviceId:string;server:string;runtimeMode:'demo';
 uptimeMs:number;cpuPercent:number;memoryBytes:number;latencyMs:number|null;
 operationsTotal:number;active:DemoTask[];transfers:DemoTransfer[];activity:DemoActivity[];
};
const root=process.platform==='win32'?'C:\\Projects\\DeskBeacon':'/projects/deskbeacon';
function activity(id:string,tool:string,description:string,request:Record<string,unknown>,result:Record<string,unknown>,
 status:string,started:number,durationMs:number,actor='ChatGPT'):DemoActivity{
 return {id,grant_id:'demo-grant',actor_name:actor,tool,description,status,
 time:started,finished_at:status==='running'?null:started+durationMs,
 duration_ms:status==='running'?null:durationMs,cwd:root,
 request_json:JSON.stringify(request),result:JSON.stringify(result)};
}
function task(id:string,description:string,start:number):DemoTask{
 return {id,description,start,kind:'background',pid:12500+Number(id.replace(/\D/g,''))};
}
export function createDemoStatus(scenario:DemoScenario='connected',now=Date.now()):DemoStatus{
 const activityList:DemoActivity[]=[
 activity('read-1','fs_read','检查项目配置',{path:root+'\\package.json',maxLines:60},
   {path:root+'\\package.json',lines:42},'completed',now-120_000,680),
 activity('edit-1','fs_edit','更新设备连接策略',{path:root+'\\apps\\client\\src\\daemon.ts',
   mode:'patch',patch:'@@ -1,3 +1,5 @@\n- const retry=1500;\n+ const retry=3000;\n+ const jitter=true;'},
   {path:root+'\\apps\\client\\src\\daemon.ts',replacements:1},'completed',now-100_000,1640,'Codex'),
 activity('cmd-1','exec_foreground','执行 TypeScript 类型检查',
   {command:{mode:'program',program:'pnpm',args:['check'],cwd:root}},
   {exitCode:0,stdout:'Checking protocol...\nChecking client...\nChecking server...\nDone.\n',durationMs:2630},
   'completed',now-80000,2630),
 activity('grep-1','fs_grep','定位 WebSocket 重连逻辑',
   {path:root+'\\apps\\client\\src',pattern:'scheduleReconnect',maxResults:20},
   {matches:[{path:'daemon.ts',line:128}]},'completed',now-60_000,240),
 activity('http-1','http_request','检查开发服务健康状态',
   {url:'http://127.0.0.1:8787/health',method:'GET'},
   {status:200,body:'ok'},'completed',now-40_000,200)
 ];
 const base:DemoStatus={state:'connected',deviceName:'ASUS-TUF-F16',deviceId:'demo-offline-device',
 server:'https://example.invalid',runtimeMode:'demo',uptimeMs:3_900_000,
 cpuPercent:8.4,memoryBytes:188_743_680,latencyMs:52,operationsTotal:activityList.length,
 active:[],transfers:[],activity:activityList};
 switch(scenario){
  case 'connecting':return {...base,state:'connecting',latencyMs:null};
  case 'offline':return {...base,state:'disconnected',latencyMs:null};
  case 'busy':return {...base,active:[
    task('task-1','启动本地 Vite 开发服务器',now-730_000),
    task('task-2','监视 TypeScript 文件变化',now-250_000)],
    activity:[activity('running-1','exec_foreground','构建桌面客户端',
     {command:{mode:'program',program:'pnpm',args:['build'],cwd:root}}, {},'running',now-17_000,0),...activityList],
    operationsTotal:activityList.length+1};
  case 'failed':return {...base,activity:[activity('failed-1','exec_foreground','执行单元测试',
    {command:{mode:'program',program:'pnpm',args:['test'],cwd:root}},
    {error:'Command exited with code 1',exitCode:1,stderr:'FAIL test/client.test.ts'},'failed',now-18_000,2030),...activityList],
    operationsTotal:activityList.length+1};
  case 'transfers':return {...base,transfers:[{
    id:'transfer-1',status:'running',path:root+'\\dist\\release.zip',
    bytes:786_432,totalBytes:1_572_864,start:now-31_000}]};
  case 'crowded':return {...base,active:Array.from({length:9},(_,index)=>
    task('task-'+(index+1),'后台任务 #'+(index+1)+'：'+(['测试监听器','构建服务','类型检查'][index%3]),
    now-((index+1)*80_000))),operationsTotal:99,memoryBytes:612_368_384,cpuPercent:37.2};
  default:return base;
 }
}
export function advanceDemo(status:DemoStatus,key:string,now=Date.now()):DemoStatus{
 if(key==='0')return createDemoStatus('connected',now);
 if(key==='1')return {...status,state:'connected',latencyMs:52};
 if(key==='2')return {...status,state:'connecting',latencyMs:null};
 if(key==='3')return {...status,state:'disconnected',latencyMs:null};
 if(key==='4'||key==='5'||key==='6'){
   const kind=key==='4'?'failed':key==='5'?'running':'completed';
   const latest=activity('demo-'+now,'exec_foreground',
     kind==='failed'?'测试命令失败':kind==='running'?'持续执行构建任务':'成功完成命令',
     {command:{mode:'program',program:'pnpm',args:['test'],cwd:root}},
     kind==='failed'?{error:'BUILD_FAILED: compilation error'}:{exitCode:0,stdout:'Build succeeded\n'},
     kind,now-2500,2500,'ChatGPT');
   return {...status,activity:[latest,...status.activity].slice(0,40),operationsTotal:status.operationsTotal+1};
 }
 if(key==='7'){
   const count=status.active.length===0?2:status.active.length<7?9:0;
   return {...status,active:Array.from({length:count},(_,i)=>
     task('task-'+(i+1),'后台服务 #'+(i+1),now-(i+1)*75_000))};
 }
 if(key==='8'){
   const existing=status.transfers[0];
   if(!existing||existing.bytes>=existing.totalBytes)return {...status,transfers:[{
     id:'transfer-1',status:'running',path:root+'\\dist\\release.zip',
     bytes:0,totalBytes:1_572_864,start:now}]};
   return {...status,transfers:[{...existing,bytes:Math.min(existing.totalBytes,existing.bytes+393_216)}]};
 }
 if(key==='9')return {...status,cpuPercent:(status.cpuPercent+19.1)%100,
   memoryBytes:Math.round(status.memoryBytes*1.15),operationsTotal:status.operationsTotal+4,
   latencyMs:status.latencyMs===null?42:status.latencyMs>=200?18:status.latencyMs+84};
 return status;
}
export const demoHelp=[
 '1 已连接  2 连接中  3 断开 / 重试',
 '4 添加失败操作  5 添加运行中操作  6 添加成功操作',
 '7 切换长期任务数量 (0 / 2 / 9)',
 '8 增加传输进度 / 重置进度',
 '9 改变 CPU、内存、命令数量和 RTT',
 '0 恢复默认场景',
 's 搜索 · / 命令 · Tab 切换焦点 · q 退出',
 '演示模式完全离线，所有操作均为模拟数据'
];
