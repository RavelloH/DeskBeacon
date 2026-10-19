import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const version=JSON.parse(readFileSync(join(root,'apps/client/package.json'),'utf8')).version;
const platform=process.platform;
const arch=process.arch;
if(platform!=='win32'||!['x64','arm64'].includes(arch))
 throw Error('This install smoke test requires Windows x64 or ARM64');
const packedDir=resolve(process.argv[2]??join(root,'packed'));
const clientTarball=join(packedDir,'deskbeacon-'+version+'.tgz');
const nativeName='win32-'+arch;
const nativeTarball=join(packedDir,'deskbeacon-'+nativeName+'-'+version+'.tgz');
for(const path of [clientTarball,nativeTarball])
 assert.ok(existsSync(path),'Missing packed release candidate: '+path);

const npmCli=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
assert.ok(existsSync(npmCli),'npm CLI was not installed alongside Node: '+npmCli);
const temp=mkdtempSync(join(tmpdir(),'deskbeacon-npm-release-'));
const install=join(temp,'install');
const env={...process.env,DESKBEACON_DATA_DIR:join(temp,'config'),
 DESKBEACON_IPC_PATH:'\\\\.\\pipe\\deskbeacon-release-'+process.pid,
 NODE_ENV:'production'};

function run(program,args,{cwd=root,timeout=120000}={}){
 const result=spawnSync(program,args,{cwd,env,windowsHide:true,encoding:'utf8',
  timeout,maxBuffer:8*1024*1024});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(program+' '+args.join(' ')+' failed ('+result.status+')\n'+
  (result.stdout??'').slice(-5000)+'\n'+(result.stderr??'').slice(-5000));
 return (result.stdout??'').trim();
}
try{
 // Install the EXACT .tgz files, not workspace dependencies or prebuilt dist.
 const out=run(process.execPath,[npmCli,'install','--prefix',install,
  '--no-save','--no-audit','--no-fund',clientTarball,nativeTarball],{timeout:180000});
 console.log(out.slice(-1200));
 const nodeModules=join(install,'node_modules');
 const client=join(nodeModules,'deskbeacon');
 const native=join(nodeModules,'@deskbeacon',nativeName);
 const clientPkg=JSON.parse(readFileSync(join(client,'package.json'),'utf8'));
 const nativePkg=JSON.parse(readFileSync(join(native,'package.json'),'utf8'));
 assert.equal(clientPkg.version,version);
 assert.equal(nativePkg.version,version);
 assert.equal(clientPkg.bin.deskbeacon,'launcher.js');
 assert.equal(clientPkg.optionalDependencies['@deskbeacon/'+nativeName],version);
 assert.equal(nativePkg.os[0],'win32');
 assert.equal(nativePkg.cpu[0],arch);
 assert.ok(existsSync(join(client,'launcher.js')));
 assert.ok(existsSync(join(client,'cli.js')));
 assert.ok(existsSync(join(native,'deskbeacon-job.exe')));
 const requireFromClient=createRequire(join(client,'launcher.js'));
 assert.equal(requireFromClient.resolve('@deskbeacon/'+nativeName+'/deskbeacon-job.exe'),
  join(native,'deskbeacon-job.exe'),'CLI must resolve its installed native Job Object helper');
 const launcher=join(client,'launcher.js');
 assert.equal(run(process.execPath,[launcher,'version']),version);
 assert.match(run(process.execPath,[launcher,'help']),/Usage: deskbeacon/);
 assert.match(run(process.execPath,[launcher,'doctor']),/Runtime\s+stopped/);
 console.log('PASS npm tarball install, CLI launcher, native binary and doctor: '+version+' '+nativeName);
}finally{
 rmSync(temp,{recursive:true,force:true,maxRetries:15,retryDelay:250});
}
