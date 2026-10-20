import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';

const dir=mkdtempSync(join(tmpdir(),'deskbeacon-update-cli-'));
const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const moduleUrl=new URL('../dist/index.js',import.meta.url).href;
const preload=join(dir,'mock-fetch.mjs');
writeFileSync(preload,`globalThis.fetch=async (url)=> {
 if(url!=='https://registry.npmjs.org/deskbeacon/latest')throw Error('Unexpected external network request');
 return new Response(JSON.stringify({version:process.env.UPDATE_TEST_LATEST??'0.3.0'}),{
 status:Number(process.env.UPDATE_TEST_STATUS??200),headers:{'content-type':'application/json'}
 });
};`);
const env={...process.env,DESKBEACON_DATA_DIR:join(dir,'empty-data'),UPDATE_TEST_LATEST:'0.3.0'};
const call=(args,overrides={})=>spawnSync(process.execPath,args,{
 cwd:dir,env:{...env,...overrides},encoding:'utf8',timeout:16000,windowsHide:true
});
try{
 const preloadUrl=pathToFileURL(preload).href;
 const command=(overrides={})=>call(['--import',preloadUrl,entry,'update'],overrides);
 const available=command();
 assert.equal(available.status,0,available.stderr);
 assert.match(available.stdout,/发现新版本：0\.2\.0 → 0\.3\.0/);
 assert.match(available.stdout,/npm install -g deskbeacon@latest/);
 assert.match(available.stdout,/npx deskbeacon@latest/);
 assert.ok(!available.stdout.includes('(( · ))'),'noninteractive CLI must not draw full screen');
 const current=command({UPDATE_TEST_LATEST:'0.2.0'});
 assert.equal(current.status,0,current.stderr);
 assert.match(current.stdout,/已是最新版本：0\.2\.0/);
 assert.doesNotMatch(current.stdout,/npm install -g/);
 const ahead=command({UPDATE_TEST_LATEST:'0.1.0'});
 assert.equal(ahead.status,0,ahead.stderr);
 assert.match(ahead.stdout,/无需降级/);
 const missing=command({UPDATE_TEST_STATUS:'404'});
 assert.equal(missing.status,1,'missing release must not silently pass');
 assert.match(missing.stderr,/npm 暂无 DeskBeacon 正式发布版本/);
 // Emulate Windows Terminal streams without making a real network request.
 const wrapper=[
  'process.stdin.isTTY=true;process.stdout.isTTY=true;',
  'process.stdout.columns=92;process.stdout.rows=26;',
  'process.stdin.setRawMode=()=>process.stdin;',
  'process.argv=[process.execPath,'+JSON.stringify(entry)+',"update"];',
  'await import('+JSON.stringify(moduleUrl)+');',
 ].join('');
 const interactive=call(['--import',preloadUrl,'--input-type=module','-e',wrapper]);
 assert.equal(interactive.status,0,interactive.stderr);
 assert.match(interactive.stdout,/━{20}/,'interactive progress must display gold top rule');
 assert.match(interactive.stdout,/检查更新/);
 assert.match(interactive.stdout,/发现新版本/);
 assert.match(interactive.stdout,/npm install -g/);
 console.log('PASS CLI update with mocked npm: interactive Ink, non-TTY, upgrade/current/ahead, 404, no automatic installation');
}finally{rmSync(dir,{recursive:true,force:true});}
