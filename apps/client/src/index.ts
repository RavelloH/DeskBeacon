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
import { showTui } from './tui.js';
import {demoScenarios, type DemoScenario} from './demo.js';

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
  if(!existsSync(configPath))await setup(await promptUrl());
}
async function currentRuntime(timeout=700):Promise<any|null>{
  try{return await requestIpc({action:'status'},timeout);}catch{return null;}
}
async function ownerRuntime(background:boolean):Promise<void>{
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
  void instance.connect();
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
  try{await showTui();}
  finally{await shutdown();}
}
async function serviceStart(){
  const running=await currentRuntime();
  if(running){console.log('DeskBeacon is already running in '+(running.runtimeMode??'legacy')+' mode ('+running.deviceName+').');return;}
  await configured();
  const child=spawn(process.execPath,[entry,'__service_run'],{
    detached:true,stdio:'ignore',windowsHide:true,cwd:process.cwd(),env:process.env
  });
  child.unref();
  for(let i=0;i<40;i++){
    await sleep(200);
    const running=await currentRuntime(600);
    if(running){console.log('DeskBeacon background service started.');return;}
  }
  throw Error('Service did not start. Run deskbeacon doctor for diagnostics.');
}
async function serviceStop(){
  const active=await currentRuntime();
  if(!active){console.log('DeskBeacon is not running.');return;}
  if(active.runtimeMode==='foreground'){console.log('The app owns this Runtime. Close its terminal or press q instead.');return;}
  await requestIpc({action:'exit'});
  for(let i=0;i<40;i++){
    if(!(await currentRuntime(400))){console.log('DeskBeacon service stopped.');return;}
    await sleep(200);
  }
  throw Error('Service did not stop within the timeout.');
}
const usage=()=>{
 console.log([
  'DeskBeacon '+pkg.version+' — Your desktop, within your agent’s reach.',
  '',
  'Usage: deskbeacon [command]',
  '',
  '  (no command)            Open full-screen DeskBeacon. Own the Runtime unless',
  '                          an existing background service is running.',
  '  setup [--url URL]       Pair this device using OAuth (prompts for URL).',
  '  demo [scenario]        Offline, interactive TUI preview (for development).',
  '  service start           Start the Runtime in the background (no TUI).',
  '  service stop            Stop the running Runtime.',
  '  service restart         Restart the background service.',
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
 const [action,...args]=process.argv.slice(2);
 if(action==='help'||action==='-h'||action==='--help'){usage();return;}
 if(action==='version'||action==='-v'||action==='--version'){console.log(pkg.version);return;}
 if(action==='update'){await updateCli();return;}
 if(action==='demo'){
   if(!process.stdin.isTTY||!process.stdout.isTTY)
     throw Error('Demo preview requires an interactive terminal.');
   const scenario=args[0]??'connected';
   if(!demoScenarios.includes(scenario as DemoScenario))
     throw Error('Unknown demo scenario. Options: '+demoScenarios.join(', '));
   await showTui(scenario as DemoScenario);
   return;
 }
 if(action==='setup'){
   const index=args.indexOf('--url');
   await setup(index>=0&&args[index+1]?args[index+1]!:await promptUrl());
   return;
 }
 if(action==='status'||(action==='service'&&args[0]==='status')){
   const status=await currentRuntime(1500);
   if(!status){console.log('DeskBeacon Runtime is not running.');return;}
   console.log(JSON.stringify(status,null,2));return;
 }
 if(action==='doctor'){
   console.log('DeskBeacon',pkg.version,'Node',process.version,'Platform',process.platform);
   console.log('Configuration',existsSync(configPath)?'available':'missing');
   if(existsSync(configPath)){const c=loadConfig();console.log('Server',c.url,'Device',c.deviceId);}
   const status=await currentRuntime();console.log('Runtime',status?.state??'stopped');
   return;
 }
 if(action==='service'){
   if(args[0]==='start'){await serviceStart();return;}
   if(args[0]==='stop'){await serviceStop();return;}
   if(args[0]==='restart'){await serviceStop();await serviceStart();return;}
   throw Error('Usage: deskbeacon service <start|stop|restart|status>');
 }
 if(action==='__service_run'){await ownerRuntime(true);return;}
 if(!action){
   if(!process.stdin.isTTY||!process.stdout.isTTY)
     throw Error('The DeskBeacon app requires an interactive terminal. Use deskbeacon service start for headless operation.');
   await configured();
   if(await currentRuntime(900)){await showTui();return;}
   await ownerRuntime(false);return;
 }
 throw Error('Unknown command '+action+'. Use deskbeacon help.');
}
void main().catch(e=>{console.error('DeskBeacon:',e instanceof Error?e.message:String(e));process.exitCode=1;});
