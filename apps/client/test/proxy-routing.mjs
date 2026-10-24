import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect as tcpConnect} from 'node:net';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';

const tmp=mkdtempSync(join(tmpdir(),'deskbeacon-proxy-test-'));
const old={HTTP_PROXY:process.env.HTTP_PROXY,HTTPS_PROXY:process.env.HTTPS_PROXY,ALL_PROXY:process.env.ALL_PROXY,NO_PROXY:process.env.NO_PROXY,http_proxy:process.env.http_proxy,https_proxy:process.env.https_proxy,no_proxy:process.env.no_proxy};
process.env.DESKBEACON_DATA_DIR=tmp;
for(const key of Object.keys(old))delete process.env[key];
const {resolveProxy,networkFetch,networkWebSocket,validateProxyUrl,clearProxyCache}=await import('../dist/outbound-network.js');
const save=(obj)=>{writeFileSync(join(tmp,'config.json'),JSON.stringify(obj));clearProxyCache();};
const local=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('DIRECT');});
const wsHttp=createServer();
const wsServer=new WebSocketServer({server:wsHttp});
wsServer.on('connection',ws=>ws.on('message',data=>ws.send('ACK:'+data.toString())));
const proxyHits=[];
const proxy=createServer((req,res)=>{
 proxyHits.push({method:req.method,url:req.url});
 res.writeHead(200,{'content-type':'text/plain'});res.end('PROXY_HTTP');
});
proxy.on('connect',(req,client,head)=>{
 proxyHits.push({method:'CONNECT',url:req.url});
 const port=wsHttp.address().port;
 const upstream=tcpConnect(port,'127.0.0.1');
 upstream.once('connect',()=>{
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if(head.length)upstream.write(head);
  client.pipe(upstream);upstream.pipe(client);
 });
 upstream.on('error',()=>client.destroy());
 client.on('error',()=>upstream.destroy());
});
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const a=await listen(local),b=await listen(wsHttp),p=await listen(proxy);
const proxyUrl='http://127.0.0.1:'+p;
try{
 await test('manual proxy overrides disabled auto and NO_PROXY, HTTP goes through proxy',async()=>{
  save({proxyAuto:false,proxyUrl});process.env.HTTP_PROXY='http://127.0.0.1:9999';process.env.NO_PROXY='*';
  const d=await resolveProxy('http://127.0.0.1:'+a+'/path');
  assert.equal(d.source,'manual');assert.equal(d.proxy,proxyUrl+'/');
  const response=await networkFetch('http://127.0.0.1:'+a+'/path',{signal:AbortSignal.timeout(4000)});
  assert.equal(await response.text(),'PROXY_HTTP');
  assert.ok(proxyHits.some(h=>h.url?.includes('/path')));
 });
 await test('MCP http_request uses shared proxy and safely truncates bodies',async()=>{
  save({proxyAuto:false,proxyUrl});
  const {networkTool}=await import('../dist/system.js');
  const data=await networkTool('http_request',{url:'http://127.0.0.1:'+a+'/tool',maxResponseBytes:5});
  assert.equal(data.status,200);
  assert.equal(data.body,'PROXY');
  assert.equal(data.truncated,true);
 }); await test('canonical JSON types and old empty-string config migration',async()=>{
  const {saveConfig,loadConfig}=await import('../dist/daemon.js');
  const {currentProxySettings}=await import('../dist/outbound-network.js');
  // Empty proxy strings written by previous versions are normalized to null.
  writeFileSync(join(tmp,'config.json'),JSON.stringify({url:'https://example.com',clientId:'legacy',deviceId:'legacy',deviceName:'legacy',accessToken:'x',proxyAuto:false,proxyUrl:''}));
  assert.equal(loadConfig().proxyUrl,null);
  assert.deepEqual(currentProxySettings(),{proxyAuto:false,proxyUrl:null});
  const cfg=loadConfig();saveConfig(cfg);
  const stored=JSON.parse((await import('node:fs')).readFileSync(join(tmp,'config.json'),'utf8'));
  assert.equal(stored.proxyUrl,null);assert.equal(typeof stored.proxyAuto,'boolean');
  save({proxyAuto:false,proxyUrl:null});
  process.env.DESKBEACON_PROXY_URL=proxyUrl;
  assert.equal(currentProxySettings().proxyUrl,null,'explicit null must not fall back to bootstrap env');
  delete process.env.DESKBEACON_PROXY_URL;
 });
 await test('auto discovers environment proxy and respects NO_PROXY',async()=>{
  save({proxyAuto:true,proxyUrl:''});process.env.HTTP_PROXY=proxyUrl;process.env.NO_PROXY='';
  const d=await resolveProxy('http://unresolvable.invalid/hello');
  assert.equal(d.source,'environment');assert.equal(d.proxy,proxyUrl+'/');
  const response=await networkFetch('http://unresolvable.invalid/hello',{signal:AbortSignal.timeout(4000)});
  assert.equal(await response.text(),'PROXY_HTTP');
  process.env.NO_PROXY='unresolvable.invalid';
  assert.equal((await resolveProxy('http://unresolvable.invalid/hello')).source,'bypass');
  process.env.NO_PROXY='';
 });
 await test('automatic proxy bypasses loopback; disabled auto ignores HTTP_PROXY',async()=>{
  save({proxyAuto:true,proxyUrl:''});
  assert.equal((await resolveProxy('http://127.0.0.1:'+a)).source,'bypass');
  assert.equal(await (await networkFetch('http://127.0.0.1:'+a)).text(),'DIRECT');
  save({proxyAuto:false,proxyUrl:''});
  assert.equal((await resolveProxy('http://unresolvable.invalid')).source,'disabled');
  assert.equal(await (await networkFetch('http://127.0.0.1:'+a)).text(),'DIRECT');
 });
 await test('websocket crosses HTTP CONNECT tunnel using same proxy setting',async()=>{
  save({proxyAuto:true,proxyUrl:proxyUrl});delete process.env.HTTP_PROXY;
  const ws=networkWebSocket('ws://unresolvable.invalid:'+b+'/sample',{handshakeTimeout:4000});
  await once(ws,'open');ws.send('PING');
  const [message]=await once(ws,'message');
  assert.equal(message.toString(),'ACK:PING');
  ws.close();await once(ws,'close');
  assert.ok(proxyHits.some(h=>h.method==='CONNECT'&&h.url.includes('unresolvable.invalid')));
 });
 await test('invalid URLs are rejected',()=>{
  assert.throws(()=>validateProxyUrl('file:///private/config'));
  assert.throws(()=>validateProxyUrl('not a valid address'));
  assert.equal(validateProxyUrl('socks5://127.0.0.1:1080'),'socks5://127.0.0.1:1080');
 });
}finally{
 await Promise.all([new Promise(ok=>local.close(ok)),new Promise(ok=>wsHttp.close(ok)),new Promise(ok=>proxy.close(ok))]);
 wsServer.close();
 rmSync(tmp,{recursive:true,force:true});
 delete process.env.DESKBEACON_DATA_DIR;
 for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
