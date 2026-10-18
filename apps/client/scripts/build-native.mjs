import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const arch=process.argv[2]??'win32-x64';
if(!['win32-x64','win32-arm64'].includes(arch))throw Error('Unknown Windows target '+arch);
const target=arch==='win32-x64'?'x86_64-w64-mingw32':'aarch64-w64-mingw32';
const ccOverride=process.env[arch==='win32-x64'?'DESKBEACON_CC_X64':'DESKBEACON_CC_ARM64'];
const rootToolchain=process.env.LLVM_MINGW_ROOT;
const cc=ccOverride??(rootToolchain?join(rootToolchain,'bin',target+'-clang'+(process.platform==='win32'?'.exe':'')):target+'-clang');
const src=join(root,'apps','client','native','win-job','job.c');
const out=join(root,'packages',arch,'deskbeacon-job.exe');
mkdirSync(dirname(out),{recursive:true});
const args=['-std=c11','-O2','-Wall','-Wextra','-municode',src,'-Wl,-s','-o',out];
const run=spawnSync(cc,args,{stdio:'inherit',windowsHide:true,cwd:root});
if(run.error)throw Error('Unable to execute '+cc+': '+run.error.message+
 '. Install llvm-mingw or set DESKBEACON_CC_'+(arch==='win32-x64'?'X64':'ARM64'));
if(run.status!==0)process.exit(run.status??1);
if(!existsSync(out))throw Error('Compiler returned success but output is missing: '+out);
const verify=spawnSync(process.execPath,[join(root,'apps','client','scripts','verify-native.mjs'),arch,out],{
 cwd:root,stdio:'inherit',windowsHide:true
});
if(verify.status!==0)process.exit(verify.status??1);
console.log('Compiled',arch,out);
