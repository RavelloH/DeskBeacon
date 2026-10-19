import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
// Windows runners may spell the same directory as RUNNER~1 or runneradmin.
// Compare filesystem-canonical paths rather than raw 8.3/long-name spellings.
const canonicalPath=value=>{
 const path=realpathSync.native(resolve(value));
 return process.platform==='win32'?path.toLowerCase():path;
};
const root=mkdtempSync(join(tmpdir(),'deskbeacon-workspace-regression-'));
process.env.DESKBEACON_DATA_DIR=join(root,'runtime');
const {ClientDaemon}=await import('../dist/daemon.js');
const config={url:'https://example.invalid',deviceId:'workspace-regression',
 clientId:'workspace-regression',accessToken:'fixture',deviceName:'Workspace Regression'};
const daemon=new ClientDaemon(config);
const exec=(tool,input,grant='grant-a')=>daemon.execute(tool,input,'test-'+Math.random().toString(36).slice(2),grant);
const run=(mode,workspaceId,cwd)=>{
 const command={mode,workspaceId,...(cwd?{cwd}:{})};
 if(mode==='program')Object.assign(command,{program:process.execPath,args:['-e','process.stdout.write(process.cwd())']});
 else Object.assign(command,{script:process.platform==='win32'?'(Get-Location).Path':'pwd -P',shellProfile:process.platform==='win32'?'powershell':'sh'});
 return exec('exec_foreground',{description:'Verify workspace command cwd',command,timeoutMs:10000});
};
try{
 const a=join(root,'a'),b=join(root,'b');
 mkdirSync(a,{recursive:true});mkdirSync(b,{recursive:true});
 const opened=await exec('workspace_open',{path:a});
 assert.equal(opened.cwd,resolve(a));
 for(const mode of ['program','shell']){
  const result=await run(mode,opened.workspaceId);
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal(canonicalPath(result.stdout.trim()),canonicalPath(a),mode+' must honor nested workspaceId');
 }
 const cd=await exec('workspace_cd',{workspaceId:opened.workspaceId,path:'../b',expectedVersion:0});
 assert.equal(cd.version,1);
 assert.equal(cd.cwd,resolve(b));
 const changed=await run('program',opened.workspaceId);
 assert.equal(canonicalPath(changed.stdout.trim()),canonicalPath(b),'command must observe workspace_cd');
 const explicit=await run('program',opened.workspaceId,a);
 assert.equal(canonicalPath(explicit.stdout.trim()),canonicalPath(a),'explicit cwd overrides workspace');
 await assert.rejects(()=>run('program','nonexistent-workspace-id'),/WORKSPACE_NOT_FOUND/);
 await assert.rejects(()=>exec('exec_foreground',{description:'isolation',command:{
  mode:'program',program:process.execPath,args:['-v'],workspaceId:opened.workspaceId
 },timeoutMs:5000},'grant-b'),/WORKSPACE_NOT_FOUND/);
 const background=await exec('exec_background',{description:'Workspace background check',
  command:{mode:'program',program:process.execPath,args:['-e','setTimeout(()=>{},300)'],workspaceId:opened.workspaceId}});
 assert.equal(resolve(background.cwd),resolve(b),'background command must honor nested workspaceId');
 await new Promise(r=>setTimeout(r,400));
 console.log('PASS nested workspaceId for foreground program and shell, background, workspace_cd, explicit cwd override and grant isolation');
}finally{
 await daemon.shutdown();
 rmSync(root,{recursive:true,force:true,maxRetries:15,retryDelay:150});
}
