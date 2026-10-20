import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const client=fileURLToPath(new URL('../',import.meta.url));
const staged=join(client,'dist','npm');
assert.ok(existsSync(join(staged,'cli.js')),'Run stage-npm.mjs before verifying the published bundle');
const contents=readFileSync(join(staged,'cli.js'),'utf8');
for(const content of ['demo-offline-device','DEMO · 场景','模拟迁移已完成，真实数据未改变'])
 assert.equal(contents.includes(content),false,'Demo data still exists in published package: '+content);
const cli=join(staged,'launcher.js');
const call=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000,windowsHide:true});
const version=call('version');assert.equal(version.status,0,version.stderr);
assert.match(version.stdout,/^0\.2\.0\s*$/);
const help=call('help');assert.equal(help.status,0,help.stderr);assert.doesNotMatch(help.stdout,/demo \[scenario\]|demo migration/);
const demo=call('demo','migration');assert.equal(demo.status,1);assert.match(demo.stderr,/Unknown command demo/);
const demo2=call('demo','connected');assert.equal(demo2.status,1);assert.match(demo2.stderr,/Unknown command demo/);
console.log('PASS release bundle excludes actual Demo data, no demo help, demo commands unavailable, CLI version stable');
