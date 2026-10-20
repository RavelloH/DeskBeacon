import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-setup-oauth-'));
process.env.DESKBEACON_DATA_DIR=root;
const {runSetupFlow,validateSetupUrl,SETUP_PHASES}=await import('../dist/setup-flow.js');
const {closeLogs}=await import('../dist/diagnostics.js');
const requests=[];
let failRegistration=false;
const mock=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=Buffer.concat(chunks).toString('utf8');
 requests.push({path:req.url,body});
 if(req.url==='/oauth/register'){
  res.writeHead(failRegistration?500:200,{'content-type':'application/json'});
  res.end(failRegistration?'error':JSON.stringify({client_id:'device-fixture'}));return;
 }
 if(req.url==='/oauth/token'){
  const form=new URLSearchParams(body);
  assert.equal(form.get('client_id'),'device-fixture');
  assert.equal(form.get('code'),'fixture-code');
  assert.ok(form.get('code_verifier'));
  assert.equal(form.get('grant_type'),'authorization_code');
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({access_token:'fixture-secret',refresh_token:'fixture-refresh',expires_in:600}));return;
 }
 res.writeHead(404);res.end();
});
try{
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
 const server='http://127.0.0.1:'+mock.address().port;
 assert.equal(validateSetupUrl(server+'/path'),server);
 assert.throws(()=>validateSetupUrl('http://example.com'),/HTTPS/);
 assert.throws(()=>validateSetupUrl('not-url'),/有效/);
 let pageUrl='',phases=[];
 const result=await runSetupFlow(server,{
  onProgress:p=>phases.push(p.stage),
  openBrowser:url=>{
   pageUrl=url;
   setImmediate(async()=>{
    const auth=new URL(url);
    const callback=new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state',auth.searchParams.get('state'));
    callback.searchParams.set('code','fixture-code');
    const response=await fetch(callback);
    assert.equal(response.status,200);
    assert.match(await response.text(),/授权成功/);
   });
  },
  timeoutMs:3000
 });
 assert.deepEqual(phases,SETUP_PHASES);
 assert.equal(result.deviceId,'device-fixture');
 assert.equal(result.server,server);
 const url=new URL(pageUrl);
 assert.equal(url.pathname,'/authorize');
 assert.equal(url.searchParams.get('scope'),'deskbeacon:device');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(url.searchParams.get('resource'),server);
 const config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));
 assert.equal(config.url,server);
 assert.equal(config.deviceId,'device-fixture');
 assert.equal(config.accessToken,'fixture-secret');
 assert.equal(config.refreshToken,'fixture-refresh');
 const preserved=readFileSync(join(root,'config.json'),'utf8');
 failRegistration=true;
 await assert.rejects(runSetupFlow(server,{openBrowser:()=>{}}),/注册失败/);
 assert.equal(readFileSync(join(root,'config.json'),'utf8'),preserved);
 failRegistration=false;
 const abort=new AbortController();
 await assert.rejects(runSetupFlow(server,{
  signal:abort.signal,openBrowser:()=>setImmediate(()=>abort.abort()),timeoutMs:4000
 }),/用户取消/);
 assert.equal(readFileSync(join(root,'config.json'),'utf8'),preserved);
 console.log('PASS local OAuth mock: Chinese stages, PKCE, callback, token persistence, failure safety and cancel');
}finally{
 await closeLogs();
 await new Promise(resolve=>mock.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
