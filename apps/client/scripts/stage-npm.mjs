import {build} from 'esbuild';
import {readFileSync,existsSync,mkdirSync,rmSync,copyFileSync,writeFileSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const client=dirname(dirname(fileURLToPath(import.meta.url)));
const root=dirname(dirname(client)),base=join(client,'dist','npm');
const source=JSON.parse(readFileSync(join(client,'package.json'),'utf8'));
if(source.private!==true)throw Error('Raw workspace client must be private; publish staged npm artifacts only');
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
const release=await build({
 entryPoints:[join(client,'src','index.ts')],
 outfile:join(base,'cli.js'),
 bundle:true,platform:'node',format:'esm',target:'node24',jsx:'automatic',legalComments:'none',
 minify:true,metafile:true,define:{__DESKBEACON_RELEASE__:'true',__DESKBEACON_PACKAGE_VERSION__:JSON.stringify(source.version)},
 plugins:[{
   name:'omit-demo-from-release',
   setup(builder){
     builder.onResolve({filter:/^\.\/(?:demo|migration-demo|migration-demo-ui)\.js$/},
       args=>({path:args.path,namespace:'release-no-demo'}));
     builder.onLoad({filter:/.*/,namespace:'release-no-demo'},args=>({
       contents:args.path==='./demo.js'?
        'export const demoScenarios=[]; export const demoHelp=[]; export const createDemoStatus=()=>null; export const advanceDemo=x=>x;':
        'export const MIGRATION_DEMO_DURATION_MS=0;export const MIGRATION_DEMO_STEPS=[];export const migrationDemoFinished=()=>true;export const migrationDemoProgress=()=>null;export const showMigrationDemo=()=>{throw Error("Unavailable in release")};',
       loader:'js'
     }));
   }
 }],
 external:[...Object.keys(source.dependencies).filter(n=>n!=='@deskbeacon/protocol'),...Object.keys(source.optionalDependencies)]
});
// Fails the release if demo modules are still reachable by the bundled entrypoint.
const demoInputPaths=Object.keys(release.metafile.inputs).filter(path=>
 /(?:^|[\\/])(?:demo|migration-demo|migration-demo-ui)\.(?:ts|tsx)$/.test(path));
if(demoInputPaths.length)throw Error('Demo source was bundled: '+demoInputPaths.join(', '));
const demoBytes=Object.values(release.metafile.outputs).flatMap(output=>
 Object.entries(output.inputs??{}).filter(([path])=>
 /(?:^|[\\/])(?:demo|migration-demo|migration-demo-ui)\.(?:ts|tsx)$/.test(path))
  .map(([path,info])=>({path,bytes:info.bytesInOutput})));
if(demoBytes.some(item=>item.bytes>0))throw Error('Release includes Demo bytes: '+JSON.stringify(demoBytes));
const optionalDependencies=Object.fromEntries(
 Object.keys(source.optionalDependencies).map(name=>[name,source.version]));
const pkg={
 name:source.name,version:source.version,description:source.description,type:'module',license:'MIT',
 repository:{type:'git',url:'git+https://github.com/RavelloH/DeskBeacon.git',directory:'apps/client'},
 homepage:'https://github.com/RavelloH/DeskBeacon#readme',
 bugs:{url:'https://github.com/RavelloH/DeskBeacon/issues'},
 keywords:['mcp','ai-agent','remote-device','cli','tui','cloudflare','remote-access'],
 engines:{node:'>=24'},bin:{deskbeacon:'launcher.js'},publishConfig:{access:'public'},
 dependencies:Object.fromEntries(Object.entries(source.dependencies).filter(([name])=>name!=='@deskbeacon/protocol')),
 optionalDependencies
};
writeFileSync(join(base,'package.json'),JSON.stringify(pkg,null,2)+'\n');
// A separate ESM bootstrap is essential: bundled ESM imports are evaluated
// before module code, so setting NODE_ENV inside cli.js is too late for React.
writeFileSync(join(base,'launcher.js'),
 '#!/usr/bin/env node\nif(!process.env.NODE_ENV)process.env.NODE_ENV="production";\nawait import("./cli.js");\n',
 {mode:0o755});
for(const name of ['README.md','LICENSE']){
 const original=join(root,name);if(existsSync(original))copyFileSync(original,join(base,name));
}
const bundled=readFileSync(join(base,'cli.js'),'utf8');
if(bundled.includes('from "@deskbeacon/protocol"')||bundled.includes("from '@deskbeacon/protocol'"))
 throw Error('npm CLI still imports an unpublished workspace package');
console.log('Staged platform-optional DeskBeacon',pkg.name,pkg.version,
 'bundled CLI KiB',Math.round(statSync(join(base,'cli.js')).size/1024));
