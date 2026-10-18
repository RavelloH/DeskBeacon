import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { ClientDaemon } from '../../client/dist/daemon.js';
const base='http://127.0.0.1:8787';
const cookies=new Map();
function takeCookies(r){for(const h of r.headers.getSetCookie()){const part=h.split(';')[0];const p=part.indexOf('=');if(p>0)cookies.set(part.slice(0,p),part.slice(p+1));}}
async function req(path,opts={}){
 const headers=new Headers(opts.headers??{});
 if(cookies.size)headers.set('cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));
 const r=await fetch(base+path,{...opts,headers,redirect:'manual'});takeCookies(r);return r;
}
const field=(html,name)=>{
 const m=html.match(new RegExp('name="'+name+'"[^>]*value="([^"]+)"'));
 if(!m)throw Error('Missing '+name+': '+html.slice(0,200));return m[1];
};
async function oauth(scope,resource){
 cookies.clear();
 const verifier=randomBytes(32).toString("base64url");
 const challenge=createHash("sha256").update(verifier).digest("base64url");
 const redirect="http://127.0.0.1:52618/callback";
 const registration=await req("/oauth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
   client_name:"DeskBeacon E2E "+scope,redirect_uris:[redirect],grant_types:["authorization_code","refresh_token"],
   response_types:["code"],token_endpoint_auth_method:"none"
 })});
 if(registration.status!==201)throw Error("Registration "+registration.status+" "+await registration.text());
 const client=await registration.json();
 const auth="/authorize?"+new URLSearchParams({client_id:client.client_id,scope,response_type:"code",redirect_uri:redirect,
   state:"test-state",code_challenge:challenge,code_challenge_method:"S256",...(resource?{resource}:{})});
 let r=await req(auth);
 if(r.status!==200){const loc=r.headers.get("location");const next=loc?new URL(loc,base):null;throw Error("Authorize GET "+r.status+" redirectPath="+(next?.pathname??"none")+" error="+(next?.searchParams.get("error")??"none"));}
 const screen=await r.text();
 assert.ok(screen.includes("name=\"secret\""),"Upstream-style secret field required");
 assert.ok(!screen.includes("name=\"username\""),"Custom username login must not return");
 const handle=field(screen,"handle");
 if(scope.includes("deskbeacon:agent")&&scope.includes("deskbeacon:device")){
   assert.ok(screen.includes('name="scope" value="deskbeacon:agent"'));
   assert.ok(!screen.includes('name="scope" value="deskbeacon:device"'),"Agent consent must not offer Device scope");
 }
 const submit=async(secret)=>req(auth,{method:"POST",headers:{"origin":base,"content-type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({handle,scope:"deskbeacon:device",secret,decision:"approve"})});
 if(scope.includes("deskbeacon:agent")){
   const denied=await submit("wrong-secret-e2e");
   assert.equal(denied.status,200,"Invalid owner key must rerender authorize page");
   assert.ok((await denied.text()).includes("secret"),"Incorrect secret must not issue tokens");
   console.log("PASS upstream-style incorrect secret rejected");
 }
 r=await submit("local-integration-only");
 if(r.status!==302)throw Error("OAuth approve "+r.status+" "+await r.text());
 const callback=new URL(r.headers.get("location"),base);
 const code=callback.searchParams.get("code");
 assert.ok(code,"No authorization code");
 r=await req("/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({grant_type:"authorization_code",code,client_id:client.client_id,
     redirect_uri:redirect,code_verifier:verifier})});
 if(r.status!==200)throw Error("Token "+r.status+" "+await r.text());
 return{clientId:client.client_id,...await r.json()};
}
async function mcp(token,method,params,id){
 const r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,
   'content-type':'application/json',accept:'application/json, text/event-stream'},
   body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
 const raw=await r.text();return {status:r.status,raw};
}
const [mcpMetadata, legacyMetadata, authMetadata] = await Promise.all([
  req('/.well-known/oauth-protected-resource/mcp'),
  req('/.well-known/oauth-protected-resource'),
  req('/.well-known/oauth-authorization-server')
]);
assert.equal(mcpMetadata.status,200);
assert.equal((await mcpMetadata.json()).resource,base+'/mcp');
assert.equal(legacyMetadata.status,200);
assert.equal((await legacyMetadata.json()).resource,base);
assert.equal(authMetadata.status,200);
const advertised=await authMetadata.json();
assert.ok(advertised.protected_resources.includes(base+'/mcp'));
assert.ok(advertised.protected_resources.includes(base));
assert.equal(advertised.registration_endpoint,base+'/oauth/register');
console.log('PASS separate MCP and legacy Device resource discovery');
const device=await oauth('deskbeacon:device');
assert.equal(device.scope,'deskbeacon:device');console.log('PASS device-only OAuth grant');
const wrongAudienceRefresh=await req('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
 grant_type:'refresh_token',client_id:device.clientId,refresh_token:device.refresh_token,resource:base+'/mcp'
})});
assert.equal(wrongAudienceRefresh.status,400,'Refresh must not retarget a legacy Device grant');
assert.equal((await wrongAudienceRefresh.json()).error,'invalid_target');
const legacyRefresh=await req('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
 grant_type:'refresh_token',client_id:device.clientId,refresh_token:device.refresh_token
})});
assert.equal(legacyRefresh.status,200,'Old Device refresh must inherit the root resource');
Object.assign(device,await legacyRefresh.json());
const oldDeviceEndpoint=await req('/device/info',{headers:{authorization:'Bearer '+device.access_token}});
assert.equal(oldDeviceEndpoint.status,200);
console.log('PASS legacy Device token audience and refresh remain valid');
// ChatGPT preserves resource=origin for previously registered OAuth clients.
// This is a real PKCE + token exchange, not a mocked bearer token.
const registeredChatgptAgent=await oauth('deskbeacon:agent deskbeacon:device',base);
assert.equal(registeredChatgptAgent.scope,'deskbeacon:agent');
const chatgptInit=await mcp(registeredChatgptAgent.access_token,'initialize',{
 protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'ChatGPT existing registration',version:'1.0'}
},90);
assert.equal(chatgptInit.status,200,'Root-resource Agent token must connect to /mcp');
const chatgptTools=await mcp(registeredChatgptAgent.access_token,'tools/list',{},91);
assert.equal(chatgptTools.status,200,'Root-resource Agent must enumerate MCP tools');
const rootAgentDevice=await fetch(base+'/device/info',{headers:{authorization:'Bearer '+registeredChatgptAgent.access_token}});
assert.equal(rootAgentDevice.status,403,'Root-resource Agent must never become a Device');
console.log('PASS existing ChatGPT root-resource OAuth Client remains authorized for MCP only');
const agent=await oauth('deskbeacon:agent deskbeacon:device',base+'/mcp');
assert.equal(agent.scope,'deskbeacon:agent','Combined scope request must never grant Device privileges');
console.log('PASS ChatGPT-style combined scope authorizes Agent ONLY');
const agentSingle=await oauth('deskbeacon:agent',base+'/mcp');
assert.equal(agentSingle.scope,'deskbeacon:agent');
console.log('PASS agent-only OAuth grant');
const deniedDevice=await fetch(base+'/device/info',{headers:{Authorization:'Bearer '+agent.access_token}});
assert.equal(deniedDevice.status,401,'Combined-scope Agent must not become a Device');
const deniedMcp=await mcp(device.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Device token denial',version:'0.1.0'}},99);
assert.equal(deniedMcp.status,401,'Device token must not become Agent');
console.log('PASS Agent and Device bearer tokens cannot cross privileges');
const daemon=new ClientDaemon({url:base,deviceId:device.clientId,clientId:device.clientId,deviceName:'E2E test device',
 accessToken:device.access_token,refreshToken:device.refresh_token});
try{
 await daemon.connect();
 for(let i=0;i<70&&(await daemon.status()).state!=='connected';i++)await new Promise(r=>setTimeout(r,100));
 console.log('Device connection:',(await daemon.status()).state);
 assert.equal((await daemon.status()).state,'connected');
 await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('DO hibernation ping timeout')),2000);
   daemon.ws.once('message',raw=>{clearTimeout(timeout);
     if(raw.toString()==='pong')resolve();else reject(Error('Unexpected keepalive response'));});
   daemon.ws.send('ping');
 });
 console.log('PASS DO hibernation auto-response ping/pong');
 await new Promise(r=>setTimeout(r,500));
 let r=await mcp(agent.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},
   clientInfo:{name:'DeskBeacon E2E',version:'0.1.0'}},1);
 console.log('initialize',r.status,r.raw.slice(0,450));assert.equal(r.status,200);
 r=await mcp(agent.access_token,'tools/list',{},2);
 console.log('tools/list',r.status,r.raw.slice(0,200));assert.equal(r.status,200);
 assert.ok(r.raw.includes('exec_foreground'));
 assert.ok(r.raw.includes('"name":"batch"'));
 assert.ok(!r.raw.includes('"name":"exec_batch"'),'Removed legacy tool must not be exposed');
 r=await mcp(agent.access_token,'tools/call',{name:'device_info',arguments:{deviceId:device.clientId}},3);
 console.log('device_info',r.status,r.raw.slice(0,650));assert.equal(r.status,200);
 assert.ok(r.raw.includes('E2E test device'));
 console.log('PASS device_info Worker -> DO -> Node');
 const decode=(answer)=>{const line=answer.raw.split('\n').find(x=>x.startsWith('data: '));if(!line)throw Error('missing SSE data '+answer.raw.slice(0,200));return JSON.parse(line.slice(6)).result?.structuredContent;};
 const invoke=async(name,args,n)=>{const result=await mcp(agent.access_token,'tools/call',{name,arguments:{deviceId:device.clientId,...args}},n);assert.equal(result.status,200,name+' HTTP');const data=decode(result);if(!data)throw Error('No structured data '+name);if(data.isError)throw Error(name+' ERROR '+JSON.stringify(data));return data;};
 const combinedBatch=await invoke('batch',{description:'E2E mixed tool batch',stages:[
   {parallel:true,calls:[
     {id:'read-project',tool:'fs_read',input:{path:'E:/DeskBeacon/package.json',maxBytes:900}},
     {id:'stat-project',tool:'fs_stat',input:{paths:['E:/DeskBeacon/package.json'],hash:false}}
   ]},
   {calls:[{id:'run-node',tool:'exec_foreground',input:{
     description:'E2E batch Node echo',
     command:{mode:'program',program:'node',args:['-e',"console.log('batch-ok')"],cwd:'E:/DeskBeacon'},
     timeoutMs:10000
   }}]}
 ]},401);
 assert.equal(combinedBatch.completed,3);
 assert.equal(combinedBatch.failed,0);
 assert.equal(combinedBatch.stages.length,2);
 assert.equal(combinedBatch.stages[1].results[0].result.data.exitCode,0);
 assert.ok(combinedBatch.stages[0].results[0].result.data.content.includes('deskbeacon'));
 console.log('PASS universal batch mixed read-only parallel stage and serial exec_foreground');
 const failedBatch=await invoke('batch',{description:'E2E mixed tool failure policy',stages:[
   {calls:[
     {id:'missing',tool:'fs_read',input:{path:'E:/DeskBeacon/not-present-batch-e2e.txt'}},
     {id:'never',tool:'device_info',input:{}}
   ]},
   {calls:[{id:'late',tool:'device_info',input:{}}]}
 ]},402);
 assert.equal(failedBatch.failed,1);
 assert.equal(failedBatch.skipped,2);
 assert.equal(failedBatch.stoppedEarly,true);
 console.log('PASS universal batch failFast stops later tools safely');
 const foreground=await invoke("exec_foreground",{description:"E2E isolated Node echo",command:{mode:"program",program:"node",args:["-e","console.log(123)"],cwd:"E:/DeskBeacon"},timeoutMs:10000},4);
 console.log('FOREGROUND',JSON.stringify(foreground).slice(0,450));assert.equal(foreground.data.exitCode,0);assert.ok(foreground.outputPreview.includes('123'));
 const history=await invoke('operation_output',{operationId:foreground.operationId,stream:'stdout',maxBytes:4096},5);assert.ok(history.output.includes('123'));console.log('PASS exec_foreground + DO output history');
 const fsread=await invoke('fs_read',{path:'E:/DeskBeacon/package.json',maxBytes:2000},6);assert.ok(fsread.data.content.includes('deskbeacon-monorepo'));console.log('PASS fs_read');
 const multiRead=await invoke('fs_read_many',{
   files:[
     {path:'E:/DeskBeacon/package.json',maxBytes:1200},
     {path:'E:/DeskBeacon/packages/protocol/src/constants.ts',lineOffset:0,maxLines:4,maxBytes:500},
     {path:'E:/DeskBeacon/missing-agentux-e2e.txt',maxBytes:200}
   ],maxTotalBytes:3000,includeHash:true
 },89);
 assert.equal(multiRead.data.files.length,3);
 assert.equal(multiRead.data.successCount,2);
 assert.equal(multiRead.data.failureCount,1);
 assert.ok(multiRead.data.files[0].sha256);
 assert.ok(multiRead.data.files[1].content.includes('PROTOCOL_VERSION'));
 assert.ok(multiRead.data.files[2].error);
 console.log('PASS fs_read_many through Worker/DO with independent file errors');
 const grep=await invoke('fs_grep',{path:'E:/DeskBeacon/packages/protocol/src',pattern:'PROTOCOL_VERSION',maxResults:10,maxBytes:40000,timeoutMs:5000},7);assert.ok(grep.data.matches.length>0);console.log('PASS ripgrep fs_grep');
 const found=await invoke('fs_find',{path:'E:/DeskBeacon/packages/protocol/src',pattern:'tools.ts',maxResults:20},26);
 assert.ok(found.data.paths.some(p=>p.endsWith('tools.ts')),'fs_find pattern should match tools.ts');
 console.log('PASS fs_find pattern');
 const http=await invoke('http_request',{method:'GET',url:'http://127.0.0.1:8787/health',maxResponseBytes:1000,timeoutMs:5000},8);assert.equal(http.data.status,200);console.log('PASS http_request from Desk');
 const info=await invoke('system_snapshot',{includeDisks:false,includeNetwork:false},9);assert.ok(info.data.memory.totalBytes>0);console.log('PASS system_snapshot');
 const dataBase64=Buffer.from('Agent->Desk test file','utf8').toString('base64');
 const upload=await invoke('transfer_upload',{description:'E2E upload',targetPath:'E:/DeskBeacon/.test-data/agent-file.txt',dataBase64,overwrite:true},10);assert.equal(upload.data.status,'completed');
 const download=await invoke('transfer_download',{description:'E2E download',sourcePath:'E:/DeskBeacon/.test-data/agent-file.txt',maxBytes:1024},11);assert.equal(Buffer.from(download.data.dataBase64,'base64').toString(),'Agent->Desk test file');console.log('PASS inline upload and download');
 const task=await invoke('exec_background',{description:'E2E background process',command:{mode:'program',program:'node',args:['-e','console.log(303);setInterval(()=>{},1000)']}},13);
 assert.ok(task.data.backgroundTaskId);console.log('PASS exec_background');
 await new Promise(r=>setTimeout(r,350));
 const bg=await invoke('background_output',{backgroundTaskId:task.data.backgroundTaskId,maxBytes:3000},14);
 assert.ok(JSON.stringify(bg).includes('303'));console.log('PASS background_output');
 await invoke('background_stop',{backgroundTaskId:task.data.backgroundTaskId},15);console.log('PASS background_stop');
 const archive=await invoke('fs_archive',{action:'create',description:'E2E zip archive',sourcePaths:['E:/DeskBeacon/.test-data/agent-file.txt'],outputPath:'E:/DeskBeacon/.test-data/agent-test.zip',format:'zip',overwrite:true,maxBytes:100000},16);
 assert.ok(archive.data.bytes>0);
 const listing=await invoke('fs_archive',{action:'list',archivePath:'E:/DeskBeacon/.test-data/agent-test.zip'},17);
 assert.ok(listing.data.entries.length>0);console.log('PASS fs_archive ZIP create/list');
 const probe=await invoke('net_probe',{mode:'tcp',host:'127.0.0.1',port:8787,timeoutMs:4000},18);assert.equal(probe.data.connected,true);console.log('PASS net_probe TCP');
 const procs=await invoke('system_processes',{pid:process.pid,limit:5},19);assert.ok(procs.data.processes.length>0);console.log('PASS system_processes');
 const pnpmVersion=await invoke('exec_foreground',{description:'E2E pnpm shim',command:{mode:'program',program:'pnpm',args:['--version'],cwd:'E:/DeskBeacon'},timeoutMs:10000},20);
 assert.equal(pnpmVersion.data.exitCode,0);console.log('PASS Windows pnpm command shim');
 const ps7=await invoke('exec_foreground',{description:'E2E PowerShell 7',command:{mode:'shell',shellProfile:'pwsh',script:'Write-Output 456',cwd:'E:/DeskBeacon'},timeoutMs:10000},21);
 assert.ok(ps7.outputPreview.includes('456'));console.log('PASS explicit PowerShell profile');
 const shot=await invoke('screen_capture',{maxWidth:128,maxHeight:90,quality:0.2,format:'jpeg'},22);
 assert.ok(shot.data.base64.length>100);console.log('PASS MCP screenshot via Agent');
 const longTask=await invoke('exec_foreground',{description:'E2E unbroken Unicode output',command:{mode:'program',program:'node',args:['-e','process.stdout.write("好".repeat(12000))'],cwd:'E:/DeskBeacon'},timeoutMs:10000},23);
 assert.equal(longTask.data.exitCode,0);
 const p1=await invoke('operation_output',{operationId:longTask.operationId,stream:'stdout',maxBytes:512},24);
 assert.equal(p1.hasMore,true);assert.ok(Number(p1.nextCursor)>0);assert.ok(p1.output.includes('好'));
 const p2=await invoke('operation_output',{operationId:longTask.operationId,stream:'stdout',byteOffset:Number(p1.nextCursor),maxBytes:512},25);
 assert.ok(Number(p2.nextCursor)>Number(p1.nextCursor));assert.ok(p2.output.includes('好'));
 console.log('PASS DO Unicode long-line history pagination: '+p1.nextCursor+' -> '+p2.nextCursor);
 const concurrentStart=Date.now();
 let peak=0;
 const gauge=setInterval(()=>{peak=Math.max(peak,daemon.supervisor.active().filter(p=>p.kind==='foreground').length);},40);
 let concurrent;
 try{
   concurrent=await Promise.all([
     invoke('exec_foreground',{description:'E2E serial first',command:{mode:'program',program:'node',args:['-e','setTimeout(()=>console.log(1111),700)']},timeoutMs:7000},31),
     invoke('exec_foreground',{description:'E2E serial second',command:{mode:'program',program:'node',args:['-e','setTimeout(()=>console.log(2222),700)']},timeoutMs:7000},32)
   ]);
 }finally{clearInterval(gauge);}
 assert.ok(concurrent[0].outputPreview.includes('1111'));assert.ok(concurrent[1].outputPreview.includes('2222'));
 assert.ok(peak<=1,'foreground overlap: '+peak);assert.ok(Date.now()-concurrentStart>=1250,'operations did not serialize');
 console.log('PASS concurrent Agent foreground calls serialize per device; max active='+peak);
 // A queued foreground request must survive waiting beyond the former 10s deadline.
 const queuedLong=invoke('exec_foreground',{description:'E2E queue first lasting 11.5s',
  command:{mode:'program',program:'node',args:['-e','setTimeout(()=>console.log(811811),11500)']},timeoutMs:18000},440);
 await new Promise(r=>setTimeout(r,350));
 const queuedBehind=invoke('exec_foreground',{description:'E2E queued successor',
  command:{mode:'program',program:'node',args:['-e','console.log(822822)']},timeoutMs:7000},441);
 const [longResult,queuedResult]=await Promise.all([queuedLong,queuedBehind]);
 assert.ok(longResult.outputPreview.includes('811811'));
 assert.ok(queuedResult.outputPreview.includes('822822'));
 console.log('PASS 11.5s queued foreground wait does not time out');

 const inFlightKey='e2e-inflight-'+Date.now();
 const sameInput={description:'E2E live idempotency reattach',command:{mode:'program',program:'node',
  args:['-e','setTimeout(()=>console.log(833833),2400)']},timeoutMs:8000,idempotencyKey:inFlightKey};
 const firstWait=invoke('exec_foreground',sameInput,442);
 await new Promise(r=>setTimeout(r,650));
 const secondWait=invoke('exec_foreground',sameInput,443);
 const [firstReply,secondReply]=await Promise.all([firstWait,secondWait]);
 assert.equal(firstReply.operationId,secondReply.operationId);
 assert.ok(firstReply.outputPreview.includes('833833'));
 assert.ok(secondReply.outputPreview.includes('833833'));
 console.log('PASS idempotent in-flight request rejoins the original operation');

 const idempotentKey='e2e-idempotent-'+Date.now();
 const one=await invoke('exec_foreground',{description:'E2E idempotent foreground',command:{mode:'program',program:'node',args:['-e','console.log(424242)']},timeoutMs:4000,idempotencyKey:idempotentKey},33);
 const two=await invoke('exec_foreground',{description:'E2E idempotent foreground',command:{mode:'program',program:'node',args:['-e','console.log(424242)']},timeoutMs:4000,idempotencyKey:idempotentKey},34);
 assert.equal(one.operationId,two.operationId);console.log('PASS idempotent foreground reuse returns the same operation, no command replay');
 const mismatch=await mcp(agent.access_token,'tools/call',{name:'exec_foreground',arguments:{deviceId:device.clientId,description:'Different command reuse of key',command:{mode:'program',program:'node',args:['-e','console.log(555555)']},timeoutMs:4000,idempotencyKey:idempotentKey}},36);
 assert.equal(mismatch.status,200);assert.ok(mismatch.raw.includes('DUPLICATE_OPERATION'));
 console.log('PASS idempotency key cannot silently alias a different command');
 await daemon.final(one.operationId,'exec_foreground',{exitCode:0,stdout:'424242\n',stderr:'',durationMs:1});
 await new Promise(r=>setTimeout(r,200));
 const duplicateState=await invoke('operation_get',{operationId:one.operationId},37);
 assert.equal(duplicateState.status,'completed');
 console.log('PASS duplicate result commit cannot corrupt a completed foreground operation');
 const secondAgent=await oauth('deskbeacon:agent',base+'/mcp');
 const wrong=await mcp(secondAgent.access_token,'tools/call',{name:'operation_get',arguments:{deviceId:device.clientId,operationId:one.operationId}},35);
 assert.equal(wrong.status,200);assert.ok(wrong.raw.includes('OPERATION_UNKNOWN'));
 console.log('PASS result history grant isolation between two Agent OAuth grants');
 const resumed=invoke('exec_foreground',{description:'E2E seamless WebSocket reconnect',command:{mode:'program',program:'node',args:['-e','setTimeout(()=>console.log(987654),3500)'],cwd:'E:/DeskBeacon'},timeoutMs:12000},27);
 await new Promise(r=>setTimeout(r,550));
 if(!daemon.ws||daemon.ws.readyState!==1)throw Error('No WebSocket to disconnect');
 daemon.ws.terminate();
 const recovery=await resumed;
 assert.equal(recovery.data.exitCode,0);assert.ok(recovery.outputPreview.includes('987654'));
 // Simulate a 7-second outage, longer than the previous 5s grace. The command
 // must keep running and its original HTTP waiter must survive without replay.
 const recovering=invoke('exec_foreground',{description:'E2E reconnect after >5s',
  command:{mode:'program',program:'node',args:['-e','setTimeout(()=>console.log(844844),10500)']},
  timeoutMs:16000},444);
 await new Promise(r=>setTimeout(r,700));
 const originalSchedule=daemon.scheduleReconnect;
 daemon.scheduleReconnect=()=>{};
 try{
  assert.equal(daemon.ws?.readyState,1);
  daemon.ws.terminate();
  await new Promise(r=>setTimeout(r,6700));
 }finally{
  daemon.scheduleReconnect=originalSchedule;
  await daemon.connect();
 }
 const resultAfterOutage=await recovering;
 assert.equal(resultAfterOutage.data.exitCode,0);
 assert.ok(resultAfterOutage.outputPreview.includes('844844'));
 console.log('PASS active foreground result survives >5s disconnect and reconnect');

 console.log('PASS foreground MCP synchronous wait survives short WebSocket disconnect and reconnect');
 await new Promise(r=>setTimeout(r,300));
 const unacked=daemon.db.prepare('SELECT COUNT(*) AS n FROM unacked_results').get();
 assert.equal(unacked.n,0,'Committed result must be ACKed and not resent forever');
 console.log('PASS final result ACK clears local replay backlog');
}finally{daemon.stop();}
