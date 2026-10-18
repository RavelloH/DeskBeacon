import { build } from 'esbuild';
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const client=dirname(dirname(fileURLToPath(import.meta.url)));
const base=join(client,'dist','npm');
const src=JSON.parse(readFileSync(join(client,'package.json'),'utf8'));
const smoke=process.argv.includes('--local-smoke');
const rid=process.argv.find(x=>x.startsWith('win-'))??'win-x64';
if(rid!=='win-x64')throw Error('Only win-x64 is supported in the initial native package');
const binDir=join(client,'dist','native',rid);
// A verified CI NativeAOT artifact can be staged without replacing a helper
// currently in use by the local DeskBeacon service.
const native=process.env.DESKBEACON_RELEASE_NATIVE??join(binDir,'deskbeacon-job.exe');
const helper=smoke?{status:0}:spawnSync(process.execPath,[join(client,'scripts','verify-native.mjs'),rid,native],{
 stdio:'inherit',windowsHide:true
});
if(helper.status!==0&&!smoke)throw Error('Refusing to assemble npm package without verified native AOT binary');
if(smoke)console.warn('LOCAL SMOKE ONLY: package is marked private and uses installed .NET runtime; NOT publishable');
rmSync(base,{recursive:true,force:true});
mkdirSync(join(base,'native',rid),{recursive:true});
await build({
 entryPoints:[join(client,'src','index.ts')],
 outfile:join(base,'cli.js'),
 bundle:true,
 platform:'node',
 format:'esm',
 target:'node24',
 jsx:'automatic',
 legalComments:'none',
 external:Object.keys(src.dependencies).filter(name=>name!=='@deskbeacon/protocol')
});
copyFileSync(native,join(base,'native',rid,'deskbeacon-job.exe'));
const pkg={
 name:src.name,
 version:src.version,
 description:src.description,
 type:'module',
 license:'MIT',
 repository:{type:'git',url:'git+https://github.com/RavelloH/DeskBeacon.git',directory:'apps/client'},
 homepage:'https://github.com/RavelloH/DeskBeacon#readme',
 bugs:{url:'https://github.com/RavelloH/DeskBeacon/issues'},
 keywords:['mcp','ai-agent','remote-device','cli','tui','cloudflare','remote-access'],
 ...(smoke?{private:true}:{}),
 engines:{node:'>=24'},
 bin:{deskbeacon:'cli.js'},
 publishConfig:{access:'public'},
 dependencies:Object.fromEntries(Object.entries(src.dependencies).filter(([name])=>name!=='@deskbeacon/protocol'))
};
writeFileSync(join(base,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const readme=join(client,'../../README.md');
if(existsSync(readme))copyFileSync(readme,join(base,'README.md'));
const license=join(client,'../../LICENSE');
if(existsSync(license))copyFileSync(license,join(base,'LICENSE'));

const compiled=readFileSync(join(base,'cli.js'),'utf8');
if(compiled.includes('from "@deskbeacon/protocol"')||compiled.includes("from '@deskbeacon/protocol'"))
 throw Error('Bundled CLI still has an unpublished workspace dependency');
console.log('Staged npm package',base,'files',readdirSync(base), 'bundled CLI KiB',Math.round(statSync(join(base,'cli.js')).size/1024));
