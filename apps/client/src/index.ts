#!/usr/bin/env node
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import stringWidth from 'string-width';
import type {DemoScenario} from './demo.js';
declare const __DESKBEACON_RELEASE__:boolean;
const DEMO_ENABLED=typeof __DESKBEACON_RELEASE__==='undefined'||!__DESKBEACON_RELEASE__;

// node:sqlite emits one known ExperimentalWarning on Node 24 even when it is
// working correctly. Filter only that specific message during module loading,
// then restore Node's warning behavior (including all other warnings).
const originalEmitWarning=process.emitWarning;
process.emitWarning=((warning:unknown,...args:unknown[])=>{
 if(typeof warning==='string'&&warning==='SQLite is an experimental feature and might change at any time'&&
    args[0]==='ExperimentalWarning')return;
 return Reflect.apply(originalEmitWarning,process,[warning,...args]);
}) as typeof process.emitWarning;
const [
 {configPath,loadConfig,saveConfig,ClientDaemon},
 {requestIpc,startIpc,closeIpc},
 {superviseService,supervisorRunning,requestSupervisorStop},
 {migrateCommand,migrationRequired,codeVersion},
 {installDiagnostics,logEvent,flushLogs,closeLogs,discardLegacyLog,logsDir}
]=await Promise.all([
 import('./daemon.js'),import('./ipc.js'),import('./service-supervisor.js'),
 import('./migration-command.js'),import('./diagnostics.js')
]).finally(()=>{process.emitWarning=originalEmitWarning;});

// React's development reconciler records unbounded performance.measure entries
// in long-lived Node TUI processes. Select production before loading Ink/React.
async function showTui(scenario?:DemoScenario,title?:string,onIntentionalExit?:(reason:string)=>void):Promise<void>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 const {showTui:launch}=await import('./tui.js');
 await launch(scenario,title,onIntentionalExit);
}

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(base?:string):Promise<void>{
 try{
 if(process.stdin.isTTY&&process.stdout.isTTY){
  const {setupTui}=await import('./setup-tui.js');
  await setupTui(base);return;
 }
 if(!base)throw Error('非交互环境请使用 deskbeacon setup --url https://服务器地址');
 const {runSetupFlow}=await import('./setup-flow.js');
 const result=await runSetupFlow(base,{onProgress:p=>{
  if(p.authorizeUrl)console.log('请在浏览器完成 OAuth 授权，如未自动打开请访问：\n'+p.authorizeUrl);
  else console.log('设备授权：'+p.stage);
 }});
 console.log('设备授权已完成：'+result.deviceId);
 }finally{await closeLogs();}
}
const pkg={version:codeVersion()};
const entry=fileURLToPath(import.meta.url);
async function configured(){
  if(!existsSync(configPath)){await setup();return;}
  const cfg=loadConfig();
  if(cfg.pendingUrl&&!await currentRuntime(700)){
    if(!process.stdin.isTTY)
      throw Error('需要重新授权服务器，请运行 deskbeacon setup --url '+cfg.pendingUrl);
    console.log('检测到待切换的服务器地址：'+cfg.pendingUrl+'，开始重新授权。');
    await setup(cfg.pendingUrl);
  }
}
async function currentRuntime(timeout=700):Promise<any|null>{
  try{return await requestIpc({action:'status'},timeout);}catch{return null;}
}
async function ownerRuntime(background:boolean,title?:string):Promise<void>{
  installDiagnostics('runtime');discardLegacyLog();
  if(migrationRequired())throw Error('STORAGE_MIGRATION_REQUIRED: run deskbeacon migrate before Runtime startup');
  process.env.DESKBEACON_RUNTIME_MODE=background?'background':'foreground';
  const instance=new ClientDaemon(loadConfig());
  logEvent('runtime','runtime.started','info',{mode:background?'service':'foreground',version:pkg.version,deviceId:instance.config.deviceId});
  const server=startIpc(instance,()=>shutdown());
  try{
    // Binding the IPC pipe is the single-owner election. A second process never connects.
    await once(server,'listening');
  }catch(e){
    instance.stop();
    if(await currentRuntime(1500))return;
    throw e;
  }
  void instance.connect().catch(e=>logEvent('connection','initial_connect_failed','error',{error:e}));
  let shutdownPromise:Promise<void>|undefined;
  const shutdown=():Promise<void>=>{
    if(shutdownPromise)return shutdownPromise;
    shutdownPromise=(async()=>{
      try{await instance.shutdown();}
      finally{
        try{await closeIpc(server);}
        finally{
          logEvent('runtime','runtime.stopped','info',{mode:background?'service':'foreground'});
          await closeLogs();
        }
      }
    })();
    return shutdownPromise;
  };
  if(background){
    const handleSignal=()=>{void shutdown().then(()=>{process.exitCode=0;});};
    process.once('SIGINT',handleSignal);
    process.once('SIGTERM',handleSignal);
    return;
  }
  try{await showTui(undefined,title);}
  finally{await shutdown();}
}
async function serviceStart(quiet=false):Promise<boolean>{
  let spawned=false;
  const running=await currentRuntime();
  if(running){
    if(!quiet)console.log('DeskBeacon is already running in '+(running.runtimeMode??'legacy')+' mode ('+running.deviceName+').');
    if(migrationRequired()&&!quiet)console.log('Storage upgrade pending: stop this Runtime before running deskbeacon migrate or service restart.');
    return false;
  }
  if(supervisorRunning()&&migrationRequired())throw Error('Stop the existing service supervisor before migrating; run deskbeacon service stop.');
  if(!supervisorRunning()){
    await configured();
    if(migrationRequired()){
      installDiagnostics('migration');discardLegacyLog();
      await migrateCommand(false);
      await closeLogs();
    }else if(!existsSync((await import('node:path')).join((await import('./daemon.js')).dataDir,'state.sqlite'))){
      // New installation: initialize storage quietly, with no legacy data to migrate.
      const {runStorageMigrations}=await import('./storage-migrations.js');
      await runStorageMigrations();
      await closeLogs();
    }
    const child=spawn(process.execPath,[entry,'__service_supervise'],{
      detached:true,stdio:'ignore',windowsHide:true,cwd:process.cwd(),env:process.env
    });
    child.unref();
    spawned=true;
  }
  for(let i=0;i<40;i++){
    await sleep(200);
    const running=await currentRuntime(600);
    if(running){if(!quiet)console.log('DeskBeacon background service started.');return spawned;}
  }
  throw Error('Service did not start. See deskbeacon service logs and run deskbeacon doctor.');
}
async function serviceStop(quiet=false){
  const active=await currentRuntime();
  if(active?.runtimeMode==='foreground'){
    if(!quiet)console.log('The app owns this Runtime. Close its terminal or press q instead.');return;
  }
  const supervised=supervisorRunning();
  if(supervised)requestSupervisorStop(!active);
  if(active)try{await requestIpc({action:'exit'},3500);}
  catch(error){
    logEvent('runtime','service.stop_ipc_unavailable','warn',{error});
    // Stop marker is already visible to the supervisor, which can terminate a stuck worker.
    if(!supervised)throw error;
  }
  else if(!supervised){if(!quiet)console.log('DeskBeacon is not running.');return;}
  // A supervisor may need its 7.5s task-drain interval and force-stop fallback.
  // Use a real deadline, not an arbitrary number of slow IPC probes.
  const deadline=Date.now()+25_000;
  while(Date.now()<deadline){
    if(!supervisorRunning()){
      const running=await currentRuntime(350);
      if(!running){if(!quiet)console.log('DeskBeacon service stopped.');return;}
    }
    await sleep(175);
  }
  logEvent('runtime','service.stop_timeout','error',{supervisorRunning:supervisorRunning()});
  throw Error('Service did not stop within 25 seconds. See deskbeacon service logs service.');
}
const logDomains=['service','runtime','connection','execution','migration','security','tui'];
const usage=()=>{
 // 按终端实际显示宽度对齐中文和 ASCII 命令。
 const commandWidth=35;
 const row=(command:string,description:string)=>'  '+command+' '.repeat(Math.max(2,commandWidth-stringWidth(command)))+description;
 const detail=(label:string,values:readonly string[])=>'  '+' '.repeat(commandWidth)+'│ '+label+'：'+values.join(' | ');
 console.log([
  'DeskBeacon '+pkg.version+' — 让 Agent 连接并使用你的设备',
  '',
  '用法：deskbeacon [命令] [选项]',
  '',
  '交互界面',
  row('(无命令)','启动全屏终端界面；Runtime 由独立 Supervisor 保护'),
  '',
  '设备与配置',
  row('setup [--url <地址>]','通过 OAuth 授权连接设备，可交互输入服务器地址'),
  row('config <name|url> [值]','查看或修改设备名称、服务器地址'),
  '',
  '服务管理',
  row('service <start|stop|restart>','启动、停止或重启后台服务'),
  row('service status [--all|--full]','查看后台服务状态；选项可包含任务历史'),
  row('status [--all|--full]','查看设备与 Runtime 状态；选项可包含任务历史'),
  row('service logs [领域]','查看指定领域的诊断日志（默认 service）'),
  detail('领域',logDomains),
  '',
  '维护工具',
  row('migrate [--no-tui]','迁移本地存储；--no-tui 使用非交互式进度'),
  row('doctor','检查本地配置和运行状态'),
  row('update','检查 npm 最新版本；交互终端显示流程树和更新建议'),
  row('version, -v, --version','查看版本号'),
  row('help, -h, --help','显示此帮助'),
  ...(DEMO_ENABLED?[
   '',
   '开发调试（仅开发构建）',
   row('demo [场景]','启动离线 TUI 演示（默认 connected）'),
   detail('场景',['connected','connecting','offline','busy','failed','transfers','crowded','migration','setup','update']),
  ]:[]),
  '',
  '全局选项',
  row('--title <名称>','设置终端窗口标题（也可使用 DESKBEACON_TITLE）'),
  '',
  '参数记法：<参数> 必填 · [参数] 可选 · | 表示枚举选项',
  'TUI 操作：? 查看快捷键 · /config 修改配置 · q 退出',
 ].join('\n'));
};
async function updateCli(){
 if(process.stdin.isTTY&&process.stdout.isTTY){
  const {updateTui}=await import('./update-tui.js');
  await updateTui(pkg.version);return;
 }
 const {checkForUpdates,updateSummary}=await import('./update-flow.js');
 const result=await checkForUpdates(pkg.version);
 console.log(updateSummary(result));
 if(result.kind==='available'){
  console.log('如需更新（不会自动安装）：');
  for(const cmd of result.commands)console.log('  '+cmd);
 }
}
async function main(){
 const argv=process.argv.slice(2);
 const titleIndex=argv.indexOf('--title');
 const title=titleIndex>=0?argv[titleIndex+1]:process.env.DESKBEACON_TITLE;
 if(titleIndex>=0&&(!title||title.startsWith('--')))throw Error('Missing --title NAME');
 if(titleIndex>=0)argv.splice(titleIndex,2);
 const [action,...args]=argv;
 if(action==='help'||action==='-h'||action==='--help'){usage();return;}
 if(action==='version'||action==='-v'||action==='--version'){console.log(pkg.version);return;}
 if(action==='update'){await updateCli();return;}
 if(DEMO_ENABLED&&action==='demo'){
   const {demoScenarios}=await import('./demo.js');
   if(!process.stdin.isTTY||!process.stdout.isTTY)
     throw Error('Demo preview requires an interactive terminal.');
   const scenario=args[0]??'connected';
   if(scenario==='migration'){
     const {showMigrationDemo}=await import('./migration-demo-ui.js');
     await showMigrationDemo();return;
   }
   if(scenario==='setup'){
     const {showSetupDemo}=await import('./setup-demo-ui.js');
     await showSetupDemo();return;
   }
   if(scenario==='update'){
     const {showUpdateDemo}=await import('./update-demo-ui.js');
     await showUpdateDemo();return;
   }
   if(!demoScenarios.includes(scenario as DemoScenario))
     throw Error('Unknown demo scenario. Options: '+[...demoScenarios,'migration','setup','update'].join(', '));
   await showTui(scenario as DemoScenario,title);
   return;
 }
 if(action==='migrate'){
   installDiagnostics('migration');discardLegacyLog();
   if(await currentRuntime(900)||supervisorRunning())throw Error('Stop the DeskBeacon service/Runtime before migrating.');
   const interactive=!args.includes('--no-tui')&&process.stdin.isTTY===true&&process.stdout.isTTY===true;
   const result=await migrateCommand(interactive);
   // The interactive migration already leaves its compact two-line result in the terminal.
   if(!interactive)console.log('DeskBeacon 存储版本 '+result.from+' → '+result.to+'；'+(result.changed?'迁移已完成':'已经是最新版本')+'。');
   await closeLogs();return;
 }
 if(action==='config'){
   const {runConfigCli}=await import('./config-cli.js');
   console.log(await runConfigCli(args));
   await closeLogs();return;
 }
 if(action==='setup'){
   const index=args.indexOf('--url');
   await setup(index>=0&&args[index+1]?args[index+1]!:undefined);
   return;
 }
 if(action==='status'||(action==='service'&&args[0]==='status')){
   const flags=action==='status'?args:args.slice(1);
   const includeHistory=flags.includes('--all')||flags.includes('--full');
   const status=await requestIpc({action:includeHistory?'status':'status-lite'},1500).catch(()=>null);
   if(!status){console.log(supervisorRunning()?'DeskBeacon Runtime is restarting under its supervisor.':'DeskBeacon Runtime is not running.');return;}
   console.log(JSON.stringify(status,null,2));return;
 }
 if(action==='doctor'){
   console.log('DeskBeacon',pkg.version,'Node',process.version,'Platform',process.platform);
   console.log('Configuration',existsSync(configPath)?'available':'missing');
   if(existsSync(configPath)){const c=loadConfig();console.log('Server',c.url,'Device',c.deviceId);}
   if(existsSync(configPath)){const {resolveProxy,redactProxy}=await import('./outbound-network.js');
    const c=loadConfig();const p=await resolveProxy(c.url);
    console.log('Proxy auto',String(c.proxyAuto===true),'Manual',redactProxy(c.proxyUrl??''));
    console.log('Proxy route',p.source,redactProxy(p.proxy));}
   const status=await currentRuntime();console.log('Runtime',status?.state??'stopped');
   return;
 }
 if(action==='service'&&args[0]==='logs'){
   const {readFileSync}=await import('node:fs');
   const {join}=await import('node:path');
   const domains=logDomains;
   const selected=args[1]??'service';
   if(!domains.includes(selected))throw Error('Unknown log domain. Choose: '+domains.join(', '));
   const path=join(logsDir,selected+'.jsonl');
   console.log(existsSync(path)?readFileSync(path,'utf8').slice(-18000):'No '+selected+' diagnostics recorded yet.');return;
 }
 if(action==='service'){
   if(args[0]==='start'){await serviceStart();return;}
   if(args[0]==='stop'){await serviceStop();return;}
   if(args[0]==='restart'){await serviceStop();await serviceStart();return;}
   throw Error('Usage: deskbeacon service <start|stop|restart|status>');
 }
 if(action==='__service_supervise'){await superviseService({workerEntry:entry});return;}
 if(action==='__service_run'){await ownerRuntime(true);return;}
 if(!action){
   if(!process.stdin.isTTY||!process.stdout.isTTY)
     throw Error('The DeskBeacon app requires an interactive terminal. Use deskbeacon service start for headless operation.');
   await configured();
   if(await currentRuntime(900)){
     if(migrationRequired())throw Error('Existing Runtime must be stopped before storage migration. Run deskbeacon service stop.');
     await showTui(undefined,title);return;
   }
   if(supervisorRunning())throw Error('Service supervisor is starting; wait or stop the background service before migrating.');
   if(migrationRequired()){installDiagnostics('migration');discardLegacyLog();await migrateCommand(true);await closeLogs();}
   else if(!existsSync((await import('node:path')).join((await import('./daemon.js')).dataDir,'state.sqlite'))){
     const {runStorageMigrations}=await import('./storage-migrations.js');
     await runStorageMigrations();await closeLogs();
   }
   // The TUI must not own the Runtime process: sudden terminal or Ink crashes
   // must leave a supervised device connection online. A deliberate q/quit
   // retains the previous foreground behavior and stops only our new service.
   const created=await serviceStart(true);
   let exitIntent:string|null=null;
   try{
    await showTui(undefined,title,reason=>{exitIntent=reason;});
   }finally{
    if(created&&exitIntent){
     logEvent('tui','foreground.intentional_stop','info',{reason:exitIntent});
     await serviceStop(true);
    }else if(created){
     logEvent('tui','foreground.detached_unexpectedly','error',{reason:'no_explicit_exit',supervisorRetained:true});
     console.error('DeskBeacon：终端界面意外结束，设备 Runtime 已交由后台 Supervisor 继续运行。可重新运行 deskbeacon 连接，或执行 deskbeacon service stop 断开。');
    }
    await flushLogs();
   }
   return;
 }
 throw Error('Unknown command '+action+'. Use deskbeacon help.');
}
void main().catch(async e=>{logEvent('runtime','cli.command_failed','error',{error:e});
  if(!(e as Error&{migrationScreenReported?:boolean;setupScreenReported?:boolean;updateScreenReported?:boolean})?.migrationScreenReported&&!((e as Error&{setupScreenReported?:boolean})?.setupScreenReported)&&!((e as Error&{updateScreenReported?:boolean})?.updateScreenReported))
   console.error('DeskBeacon:',e instanceof Error?e.message:String(e));
  await flushLogs();process.exitCode=1;});
