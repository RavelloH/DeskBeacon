#!/usr/bin/env node
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { configPath, loadConfig, saveConfig, ClientDaemon } from './daemon.js';
import { requestIpc, startIpc } from './ipc.js';
import { showTui } from './tui.js';

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
   const register=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({client_name:'DeskBeacon Device '+hostname(),redirect_uris:[redirect],
       token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
   if(!register.ok)throw Error('Device OAuth registration failed: HTTP '+register.status+' '+(await register.text()).slice(0,500));
   const client=await register.json() as {client_id:string};
   if(!client.client_id)throw Error('No OAuth client_id in registration result');
   const authorize=new URL('/authorize',base);
   authorize.searchParams.set('response_type','code');authorize.searchParams.set('client_id',client.client_id);
   authorize.searchParams.set('redirect_uri',redirect);authorize.searchParams.set('scope','deskbeacon:device');
   authorize.searchParams.set('state',state);authorize.searchParams.set('code_challenge',challenge);
   authorize.searchParams.set('code_challenge_method','S256');
   console.log('Open the authorization page and sign in with Owner credentials:\n'+authorize.href);
   openBrowser(authorize.href);
   const authorizationCode=await Promise.race([code,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('OAuth callback timeout')),180_000))]);
   const token=await fetch(base+'/token',{method:'POST',
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
async function launchDaemon(){
 try{return await requestIpc({action:'status'},900);}catch{}
 if(!existsSync(configPath))throw Error('Not configured; run deskbeacon setup --url YOUR_WORKER_URL');
 const child=spawn(process.execPath,[process.argv[1]!, 'daemon'],{detached:true,stdio:'ignore',
   windowsHide:true,cwd:process.cwd()});
 child.unref();
 for(let attempt=0;attempt<35;attempt++){
   await sleep(200);
   try{return await requestIpc({action:'status'},600);}catch{}
 }
 throw Error('Daemon failed to start; run deskbeacon daemon in foreground for diagnostics');
}
async function main(){
 const action=process.argv[2]??'launch';
 if(action==='setup'||action==='login'){const n=process.argv.indexOf('--url');const target=n>=0?process.argv[n+1]:undefined;
   if(!target)throw Error('Usage: deskbeacon setup --url https://your-worker.example');
   await setup(target);return;}
 if(action==='daemon'){
   const instance=new ClientDaemon(loadConfig());
   startIpc(instance);void instance.connect();
   process.on('SIGINT',()=>{instance.stop();process.exit(0);});
   process.on('SIGTERM',()=>{instance.stop();process.exit(0);});
   return;
 }
 if(action==='doctor'){
   console.log('Node',process.version,'Platform',process.platform,'Config',existsSync(configPath)?'available':'missing');
   if(existsSync(configPath)){const config=loadConfig();console.log('Server',config.url,'Device',config.deviceId);}
   try{const status=await requestIpc({action:'status'});console.log('Daemon',status.state);}
   catch{console.log('Daemon stopped');}return;
 }
 if(action==='stop'){console.log(await requestIpc({action:'exit'}));return;}
 if(action==='status'){console.log(JSON.stringify(await requestIpc({action:'status'}),null,2));return;}
 if(action==='tui'){await showTui();return;}
 if(action==='start'){console.log(await launchDaemon());return;}
 if(action==='launch'){
   if(!existsSync(configPath)){
     if(!process.stdin.isTTY)throw Error('Device not configured. Run deskbeacon setup --url https://your-worker.example');
     const io=createInterface({input:process.stdin,output:process.stdout});
     let serverUrl='';
     try{serverUrl=(await io.question('DeskBeacon Worker URL (https://...): ')).trim();}
     finally{io.close();}
     if(!serverUrl)throw Error('Worker URL is required for first-time OAuth pairing');
     await setup(serverUrl);
   }
   await launchDaemon();await showTui();return;
 }
 throw Error('Unknown command '+action+'. Use setup/start/tui/status/stop/doctor/daemon.');
}
void main().catch(e=>{console.error('DeskBeacon:',e instanceof Error?e.message:String(e));process.exitCode=1;});
