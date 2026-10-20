#!/usr/bin/env node
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { configPath, loadConfig, saveConfig, ClientDaemon } from './daemon.js';
import { requestIpc, startIpc } from './ipc.js';
import {demoScenarios, type DemoScenario} from './demo.js';
import {superviseService,supervisorRunning,requestSupervisorStop} from './service-supervisor.js';

// React's development reconciler records unbounded performance.measure entries
// in long-lived Node TUI processes. Select production before loading Ink/React.
async function showTui(scenario?:DemoScenario,title?:string):Promise<void>{
 if(!process.env.NODE_ENV)process.env.NODE_ENV='production';
 const {showTui:launch}=await import('./tui.js');
 await launch(scenario,title);
}

const url64=(value:Buffer)=>value.toString('base64url');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function openBrowser(url:string){
 if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore'}).unref();
 else spawn(process.platform==='darwin'?'open':'xdg-open',[url],{detached:true,stdio:'ignore'}).unref();
}
async function setup(base:string) {
 const parsed=new URL(base);
 if(parsed.protocol!=='https:'&&!(parsed.hostname==='127.0.0.1'||parsed.hostname==='localhost'))throw Error('HTTPS server required');
 base=parsed.origin;
 const codeVerifier=url64(randomBytes(32));
 const challenge=url64(createHash('sha256').update(codeVerifier).digest());
 const state=url64(randomBytes(24));
 let resolveCode!:(code:string)=>void, rejectCode!:(error:Error)=>void;
 const code=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
 const callback=createServer((req,res)=>{
   const params=new URL(req.url??'/',base);
   if(params.pathname!=='/callback'){res.writeHead(404);res.end();return;}
   if(params.searchParams.get('state')!==state){res.writeHead(403);res.end('OAuth state mismatch');rejectCode(Error('OAuth state mismatch'));return;}
   const authorizationCode=params.searchParams.get('code');
   if(!authorizationCode){res.writeHead(400);res.end('Missing OAuth code');rejectCode(Error('Missing OAuth code'));return;}
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
   res.end('<h2>(( · )) DeskBeacon paired successfully.</h2><p>You can close this tab and return to the terminal.</p>');
   resolveCode(authorizationCode);
 });
 await new Promise<void>(resolve=>callback.listen(0,'127.0.0.1',resolve));
 const addr=callback.address();if(!addr||typeof addr==='string')throw Error('Local callback unavailable');
 const redirect='http://127.0.0.1:'+addr.port+'/callback';
 try {
   const register=await fetch(base+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({client_name:'DeskBeacon Device '+hostname(),redirect_uris:[redirect],
       token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
   if(!register.ok)throw Error('Device OAuth registration failed: HTTP '+register.status+' '+(await register.text()).slice(0,500));
   const client=await register.json() as {client_id:string};
   if(!client.client_id)throw Error('No OAuth client_id in registration result');
   const authorize=new URL('/authorize',base);
   authorize.searchParams.set('response_type','code');authorize.searchParams.set('client_id',client.client_id);
   authorize.searchParams.set('redirect_uri',redirect);authorize.searchParams.set('scope','deskbeacon:device');
   authorize.searchParams.set('resource',base); // Explicit legacy Device audience; older installed clients may still omit it.
   authorize.searchParams.set('state',state);authorize.searchParams.set('code_challenge',challenge);
   authorize.searchParams.set('code_challenge_method','S256');
   console.log('Open the authorization page and enter your OAuth authorization secret:\n'+authorize.href);
   openBrowser(authorize.href);
   const authorizationCode=await Promise.race([code,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('OAuth callback timeout')),180_000))]);
   const token=await fetch(base+'/oauth/token',{method:'POST',
     headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
       grant_type:'authorization_code',client_id:client.client_id,code:authorizationCode,
       redirect_uri:redirect,code_verifier:codeVerifier
     })});
   if(!token.ok)throw Error('OAuth token exchange failed: '+token.status+' '+(await token.text()).slice(0,300));
   const credentials=await token.json() as {access_token:string;refresh_token?:string;expires_in?:number};
   if(!credentials.access_token)throw Error('OAuth did not return access token');
   saveConfig({url:base,clientId:client.client_id,deviceId:client.client_id,accessToken:credentials.access_token,
     ...(credentials.refresh_token?{refreshToken:credentials.refresh_token}:{}),...(credentials.expires_in?{accessTokenExpiresAt:Date.now()+credentials.expires_in*1000}:{}),deviceName:hostname()});
   console.log('DeskBeacon device paired. Device ID: '+client.client_id);
 }finally{callback.close();}
}
const pkg={version:'0.2.0'};
const entry=fileURLToPath(import.meta.url);
async function promptUrl():Promise<string>{
  if(!process.stdin.isTTY)throw Error('Run deskbeacon setup --url https://your-worker.example from a terminal');
  const io=createInterface({input:process.stdin,output:process.stdout});
  try{
    const url=(await io.question('DeskBeacon Worker URL (https://...): ')).trim();
    if(!url)throw Error('Worker URL is required');
    return url;
  }finally{io.close();}
}
async function configured(){
  if(!existsSync(configPath)){await setup(await promptUrl());return;}
  const cfg=loadConfig();
  if(cfg.pendingUrl&&!await currentRuntime(700)){
    if(!process.stdin.isTTY)
      throw Error('SERVER_REAUTH_REQUIRED: run deskbeacon setup --url '+cfg.pendingUrl+' interactively');
    console.log('DeskBeacon server change pending: '+cfg.pendingUrl+' · authorizing new server.');
    await setup(cfg.pendingUrl);
  }
}
async function currentRuntime(timeout=700):Promise<any|null>{
  try{return await requestIpc({action:'status'},timeout);}catch{return null;}
}
async function ownerRuntime(background:boolean,title?:string):Promise<void>{
  process.env.DESKBEACON_RUNTIME_MODE=background?'background':'foreground';
  const instance=new ClientDaemon(loadConfig());
  const server=startIpc(instance);
  try{
    // Binding the IPC pipe is the single-owner election. A second process never connects.
    await once(server,'listening');
  }catch(e){
    instance.stop();
    if(await currentRuntime(1500))return;
    throw e;
  }
  void instance.connect().catch(e=>console.error('Runtime initial connection:',String(e)));
  let exiting=false;
  const shutdown=async()=>{
    if(exiting)return;
    exiting=true;
    await instance.shutdown();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
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
async function serviceStart(){
  const running=await currentRuntime();
  if(running){console.log('DeskBeacon is already running in '+(running.runtimeMode??'legacy')+' mode ('+running.deviceName+').');return;}
  if(!supervisorRunning()){
    await configured();
    const child=spawn(process.execPath,[entry,'__service_supervise'],{
      detached:true,stdio:'ignore',windowsHide:true,cwd:process.cwd(),env:process.env
    });
    child.unref();
  }
  for(let i=0;i<40;i++){
    await sleep(200);
    const running=await currentRuntime(600);
    if(running){console.log('DeskBeacon background service started.');return;}
  }
  throw Error('Service did not start. See deskbeacon service logs and run deskbeacon doctor.');
}
async function serviceStop(){
  const active=await currentRuntime();
  if(active?.runtimeMode==='foreground'){
    console.log('The app owns this Runtime. Close its terminal or press q instead.');return;
  }
  const supervised=supervisorRunning();
  if(supervised)requestSupervisorStop(!active);
  if(active)await requestIpc({action:'exit'});
  else if(!supervised){console.log('DeskBeacon is not running.');return;}
  for(let i=0;i<50;i++){
    const running=await currentRuntime(400);
    if(!running&&!supervisorRunning()){
      console.log('DeskBeacon service stopped.');return;
    }
    await sleep(200);
  }
  throw Error('Service did not stop within the timeout. Check the service log.');
}
const usage=()=>{
 console.log([
  'DeskBeacon '+pkg.version+' — Your desktop, within your agent’s reach.',
  '',
  'Usage: deskbeacon [command] [--title NAME]',
  '',
  '  (no command)            Open full-screen DeskBeacon. Own the Runtime unless',
  '                          an existing background service is running.',
  '  setup [--url URL]       Pair this device using OAuth (prompts for URL).',
  '  demo [scenario]        Offline, interactive TUI preview (for development).',
  '  --title NAME           Terminal window title (also DESKBEACON_TITLE env).',
  '  service start           Start the Runtime in the background (no TUI).',
  '  service stop            Stop the running Runtime.',
  '  service restart         Restart the background service.',
  '  service logs            Print last 18 KB of background service logs.',
  '  service status          Show background Runtime status.',
  '  status                  Print connected device/Runtime status.',
  '  doctor                  Check configuration and Runtime.',
  '  update                  Check the latest npm release and show update steps.',
  '  version, -v, --version  Show CLI version.',
  '  help, -h, --help        Display this help.',
  '',
  'Inside TUI: ? for keys, /config for settings, q to close.',
 ].join('\n'));
};
async function updateCli(){
  const remote=await fetch('https://registry.npmjs.org/deskbeacon/latest',{signal:AbortSignal.timeout(8000)});
  if(!remote.ok){console.log('No published npm release available (HTTP '+remote.status+').');return;}
  const data=await remote.json() as {version?:string};
  console.log('Installed '+pkg.version+' · Latest '+(data.version??'unknown'));
  if(data.version!==pkg.version)console.log('Use npx deskbeacon@latest or npm install -g deskbeacon@latest.');
  else console.log('You are up to date.');
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
 if(action==='demo'){
   if(!process.stdin.isTTY||!process.stdout.isTTY)
     throw Error('Demo preview requires an interactive terminal.');
   const scenario=args[0]??'connected';
   if(!demoScenarios.includes(scenario as DemoScenario))
     throw Error('Unknown demo scenario. Options: '+demoScenarios.join(', '));
   await showTui(scenario as DemoScenario,title);
   return;
 }
 if(action==='setup'){
   const index=args.indexOf('--url');
   await setup(index>=0&&args[index+1]?args[index+1]!:await promptUrl());
   return;
 }
 if(action==='status'||(action==='service'&&args[0]==='status')){
   const status=await currentRuntime(1500);
   if(!status){console.log(supervisorRunning()?'DeskBeacon Runtime is restarting under its supervisor.':'DeskBeacon Runtime is not running.');return;}
   console.log(JSON.stringify(status,null,2));return;
 }
 if(action==='doctor'){
   console.log('DeskBeacon',pkg.version,'Node',process.version,'Platform',process.platform);
   console.log('Configuration',existsSync(configPath)?'available':'missing');
   if(existsSync(configPath)){const c=loadConfig();console.log('Server',c.url,'Device',c.deviceId);}
   const status=await currentRuntime();console.log('Runtime',status?.state??'stopped');
   return;
 }
 if(action==='service'&&args[0]==='logs'){
   const {readFileSync}=await import('node:fs');
   const {dataDir}=await import('./daemon.js');
   const logPath=(await import('node:path')).join(dataDir,'service.log');
   console.log(existsSync(logPath)?readFileSync(logPath,'utf8').slice(-18000):'No service diagnostics recorded yet.');return;
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
   if(await currentRuntime(900)){await showTui(undefined,title);return;}
   await ownerRuntime(false,title);return;
 }
 throw Error('Unknown command '+action+'. Use deskbeacon help.');
}
void main().catch(e=>{console.error('DeskBeacon:',e instanceof Error?e.message:String(e));process.exitCode=1;});
