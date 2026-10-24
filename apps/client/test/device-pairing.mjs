import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

const tmp=mkdtempSync(join(tmpdir(),'deskbeacon-headless-setup-'));
process.env.DESKBEACON_DATA_DIR=tmp;
const {runDeviceSetupFlow,DEVICE_SETUP_PHASES}=await import('../dist/device-pairing.js');
const {closeLogs}=await import('../dist/diagnostics.js');
let server,stop=false,failNextPoll=false,requests=[],challenge='',polls=0;
const http=createServer(async(req,res)=>{
 const parts=[];for await(const buf of req)parts.push(buf);
 const raw=Buffer.concat(parts).toString('utf8');
 const url=req.url;
 requests.push(url);
 const out=(code,value)=>{
  res.writeHead(code,{'content-type':'application/json'});
  res.end(JSON.stringify(value));
 };
 if(url==='/oauth/register'){
  const json=JSON.parse(raw);
  assert.deepEqual(json.redirect_uris,['http://127.0.0.1:'+http.address().port+'/pair/callback']);
  assert.equal(json.token_endpoint_auth_method,'none');
  out(200,{client_id:'registered-headless-client'});return;
 }
 if(url==='/pair/start'){
  const json=JSON.parse(raw);
  assert.equal(json.client_id,'registered-headless-client');
  challenge=json.code_challenge;
  assert.match(challenge,/^[\w-]{43}$/);
  out(200,{device_code:'q'.repeat(43),user_code:'ABCD-2345',
    verification_uri:server+'/activate',expires_in:300,interval:3});return;
 }
 if(url==='/pair/poll'){
  assert.equal(JSON.parse(raw).device_code,'q'.repeat(43));polls++;
  if(failNextPoll){failNextPoll=false;res.destroy();return;}
  if(stop){out(202,{status:'pending',interval:3});return;}
  // first success without sleeping; the sleep behavior is covered by cancellation test.
  out(200,{status:'authorized',code:'real-authorization-code-123'});return;
 }
 if(url==='/oauth/token'){
  const form=new URLSearchParams(raw);
  assert.equal(form.get('grant_type'),'authorization_code');
  assert.equal(form.get('client_id'),'registered-headless-client');
  assert.equal(form.get('redirect_uri'),server+'/pair/callback');
  assert.equal(form.get('code'),'real-authorization-code-123');
  const verify=createHash('sha256').update(form.get('code_verifier')).digest('base64url');
  assert.equal(verify,challenge);
  out(200,{access_token:'secret-token-from-upstream',refresh_token:'refresh-from-upstream',expires_in:600});return;
 }
 out(404,{error:'not_found'});
});
try{
 http.listen(0,'127.0.0.1');await once(http,'listening');
 server='http://127.0.0.1:'+http.address().port;
 const progress=[];
 const result=await runDeviceSetupFlow(server,{onProgress:p=>progress.push(p),timeoutMs:6000});
 assert.deepEqual(progress.map(p=>p.stage),DEVICE_SETUP_PHASES);
 assert.equal(progress[3].mode,'device');
 assert.equal(progress[3].userCode,'ABCD-2345');
 assert.equal(progress[3].verificationUri,server+'/activate');
 assert.equal(result.deviceId,'registered-headless-client');
 assert.equal(polls,1);
 const cfg=JSON.parse(readFileSync(join(tmp,'config.json'),'utf8'));
 assert.equal(cfg.accessToken,'secret-token-from-upstream');
 assert.equal(cfg.refreshToken,'refresh-from-upstream');
 assert.equal(cfg.deviceId,cfg.clientId);
 assert.equal(cfg.proxyAuto,false);assert.equal(cfg.proxyUrl,null);
 // A single failed network poll should recover without losing the OAuth pairing.
 failNextPoll=true;
 const pollsBeforeRetry=polls;
 await runDeviceSetupFlow(server,{timeoutMs:9000});
 assert.equal(polls,pollsBeforeRetry+2,'transient network failure should trigger retry');
 const before=readFileSync(join(tmp,'config.json'),'utf8');
 stop=true;
 const abort=new AbortController();
 await assert.rejects(runDeviceSetupFlow(server,{
  signal:abort.signal,timeoutMs:7000,onProgress:p=>{if(p.userCode)abort.abort();}
 }),/取消/);
 assert.equal(readFileSync(join(tmp,'config.json'),'utf8'),before,'cancel must preserve existing tokens');
 console.log('PASS headless pairing: OAuth registration, PKCE, token persistence, transient polling retry and cancellation');
}finally{
 await closeLogs();
 await new Promise(resolve=>http.close(resolve));
 rmSync(tmp,{recursive:true,force:true});
}
