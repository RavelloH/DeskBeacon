import {build} from 'esbuild';
import {readFileSync,existsSync,mkdirSync,rmSync,copyFileSync,writeFileSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const client=dirname(dirname(fileURLToPath(import.meta.url)));
const root=dirname(dirname(client)),base=join(client,'dist','npm');
const source=JSON.parse(readFileSync(join(client,'package.json'),'utf8'));
if(!source.optionalDependencies?.['@deskbeacon/win32-x64']||
   !source.optionalDependencies?.['@deskbeacon/win32-arm64'])
 throw Error('Platform optionalDependencies are missing');
const platforms=['win32-x64','win32-arm64'];
for(const arch of platforms){
 const pkg=JSON.parse(readFileSync(join(root,'packages',arch,'package.json'),'utf8'));
 if(pkg.version!==source.version||pkg.name!=='@deskbeacon/'+arch)
  throw Error('Platform package version or name does not match '+source.version+': '+arch);
 if(!process.argv.includes('--skip-native-verification')){
  if(!existsSync(join(root,'packages',arch,'deskbeacon-job.exe')))
   throw Error('Missing '+arch+' binary: build both platforms before staging npm');
 }
}
rmSync(base,{recursive:true,force:true});
mkdirSync(base,{recursive:true});
await build({
 entryPoints:[join(client,'src','index.ts')],
 outfile:join(base,'cli.js'),
 bundle:true,platform:'node',format:'esm',target:'node24',jsx:'automatic',legalComments:'none',
 external:[...Object.keys(source.dependencies).filter(n=>n!=='@deskbeacon/protocol'),...Object.keys(source.optionalDependencies)]
});
const optionalDependencies=Object.fromEntries(
 Object.keys(source.optionalDependencies).map(name=>[name,source.version]));
const pkg={
 name:source.name,version:source.version,description:source.description,type:'module',license:'MIT',
 repository:{type:'git',url:'git+https://github.com/RavelloH/DeskBeacon.git',directory:'apps/client'},
 homepage:'https://github.com/RavelloH/DeskBeacon#readme',
 bugs:{url:'https://github.com/RavelloH/DeskBeacon/issues'},
 keywords:['mcp','ai-agent','remote-device','cli','tui','cloudflare','remote-access'],
 engines:{node:'>=24'},bin:{deskbeacon:'cli.js'},publishConfig:{access:'public'},
 dependencies:Object.fromEntries(Object.entries(source.dependencies).filter(([name])=>name!=='@deskbeacon/protocol')),
 optionalDependencies
};
writeFileSync(join(base,'package.json'),JSON.stringify(pkg,null,2)+'\n');
for(const name of ['README.md','LICENSE']){
 const original=join(root,name);if(existsSync(original))copyFileSync(original,join(base,name));
}
const bundled=readFileSync(join(base,'cli.js'),'utf8');
if(bundled.includes('from "@deskbeacon/protocol"')||bundled.includes("from '@deskbeacon/protocol'"))
 throw Error('npm CLI still imports an unpublished workspace package');
console.log('Staged platform-optional DeskBeacon',pkg.name,pkg.version,
 'bundled CLI KiB',Math.round(statSync(join(base,'cli.js')).size/1024));
