import assert from 'node:assert/strict';
import {checkForUpdates,compareVersions,UPDATE_PHASES,UPDATE_COMMANDS,updateSummary} from '../dist/update-flow.js';

const cases=[
 ['0.2.0','0.3.0',-1],
 ['0.9.0','0.10.0',-1],
 ['1.0.0','0.9.9',1],
 ['1.0.0','1.0.0',0],
 ['v1.2.3','1.2.3+build.9',0],
 ['1.0.0-beta.2','1.0.0-beta.10',-1],
 ['1.0.0-rc.1','1.0.0',-1],
 ['1.0.0-alpha','1.0.0-alpha.1',-1],
 ['1.0.0-alpha.1','1.0.0-alpha.beta',-1],
];
for(const [a,b,result] of cases)assert.equal(compareVersions(a,b),result,a+' vs '+b);
assert.throws(()=>compareVersions('1.2','1.2.3'),/无法识别/);
let requested='';
const fake=version=>async url=>{
 requested=url;
 return new Response(JSON.stringify({version}),{status:200,headers:{'content-type':'application/json'}});
};
const phases=[];
const available=await checkForUpdates('0.2.0',{fetcher:fake('0.3.0'),onProgress:p=>phases.push(p.stage)});
assert.deepEqual(phases,UPDATE_PHASES);
assert.equal(requested,'https://registry.npmjs.org/deskbeacon/latest');
assert.equal(available.kind,'available');
assert.deepEqual(available.commands,UPDATE_COMMANDS);
assert.match(updateSummary(available),/0\.2\.0 → 0\.3\.0/);
const current=await checkForUpdates('0.2.0',{fetcher:fake('0.2.0')});
assert.equal(current.kind,'current');assert.deepEqual(current.commands,[]);
const ahead=await checkForUpdates('0.3.0',{fetcher:fake('0.2.0')});
assert.equal(ahead.kind,'ahead');assert.deepEqual(ahead.commands,[]);
assert.match(updateSummary(ahead),/无需降级/);
await assert.rejects(checkForUpdates('0.2.0',{fetcher:async()=>new Response('not found',{status:404})}),/暂无.*发布版本/);
await assert.rejects(checkForUpdates('0.2.0',{fetcher:async()=>new Response('server error',{status:503})}),/HTTP 503/);
await assert.rejects(checkForUpdates('0.2.0',{fetcher:async()=>new Response('not json')}),/JSON/);
await assert.rejects(checkForUpdates('0.2.0',{fetcher:fake('bad-version')}),/无法识别版本号/);
await assert.rejects(checkForUpdates('0.2.0',{fetcher:fake('')}),/缺少版本号/);
await assert.rejects(checkForUpdates('0.2.0',{fetcher:async()=>{throw Error('offline')}}),/offline/);
const controller=new AbortController();
const aborted=checkForUpdates('0.2.0',{
 signal:controller.signal,
 fetcher:async(_url,init)=>new Promise((_resolve,reject)=>{
  init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
 }),
});
controller.abort();
await assert.rejects(aborted,/已取消/);
const timeoutCheck=assert.rejects(checkForUpdates('0.2.0',{
 timeoutMs:15,
 fetcher:async(_url,init)=>new Promise((_resolve,reject)=>{
  init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
 }),
}),/超时/);
await Promise.all([timeoutCheck,new Promise(resolve=>setTimeout(resolve,45))]);
console.log('PASS SemVer comparison, update/no-update/ahead, progress events, errors, timeout, and cancellation');
