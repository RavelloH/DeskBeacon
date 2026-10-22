import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileTool } from '../dist/filesystem.js';
import { TaskSupervisor } from '../dist/process.js';
import { normalizeToolError,toolInputSchemas,batchInputSchema,executeToolBatch } from '../../../packages/protocol/dist/index.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-mcp-reliability-'));
const db=new DatabaseSync(join(root,'state.sqlite'));
const supervisor=new TaskSupervisor(db,join(root,'output'));
const sha=text=>createHash('sha256').update(text).digest('hex');
try {
 const nested=join(root,'created','inner','sample.txt');
 await assert.rejects(()=>fileTool('fs_write',{path:nested,mode:'create',content:'head\nexample\nend\n'}),{code:'ENOENT'});
 const write=await fileTool('fs_write',{path:nested,mode:'create',content:'head\nexample\nend\n',createParents:true});
 assert.equal(write.writtenBytes,17);
 const stats=await fileTool('fs_stat',{paths:[nested]});
 assert.equal(stats.entries[0].type,'file');
 assert.equal(stats.entries[0].kind,'file');
 const listing=await fileTool('fs_list',{path:join(root,'created','inner')});
 assert.equal(listing.entries[0].modifiedAt,listing.entries[0].modified);
 assert.equal(listing.entries[0].kind,'file');

 const emptyDir=join(root,'empty-directory','leaf');
 const ignoredDir=join(root,'ignored-folder');
 const hiddenDir=join(root,'.hidden-folder');
 mkdirSync(emptyDir,{recursive:true});
 mkdirSync(ignoredDir,{recursive:true});
 mkdirSync(hiddenDir,{recursive:true});
 writeFileSync(join(root,'.gitignore'),'ignored-folder/\n');
 const gitInit=spawnSync('git',['init','-q'],{cwd:root});
 assert.equal(gitInit.status,0,'Git must be available for ignore regression');
 const found=await fileTool('fs_find',{path:root,includeDirectories:true,respectIgnore:false,includeHidden:true,maxResults:30});
 assert.ok(found.paths.some(x=>x.endsWith('inner')),'directory should be discoverable');
 assert.ok(found.entries.some(x=>x.path===emptyDir&&x.kind==='directory'),'empty nested directory should be discoverable');
 assert.ok(found.entries.some(x=>x.path===ignoredDir&&x.kind==='directory'),'respectIgnore=false includes ignored folder');
 const filtered=await fileTool('fs_find',{path:root,includeDirectories:true,respectIgnore:true,includeHidden:false,maxResults:30});
 assert.ok(filtered.paths.includes(emptyDir),'includeDirectories must find empty directories even with ignore rules');
 assert.ok(!filtered.paths.includes(ignoredDir),'Git ignored folders must not be listed');
 assert.ok(!filtered.paths.includes(hiddenDir),'hidden folder should be excluded');
 const noDirs=await fileTool('fs_find',{path:root,includeDirectories:false,respectIgnore:false,maxResults:30});
 assert.ok(!noDirs.paths.includes(emptyDir),'includeDirectories=false must preserve file-only behavior');
 const globbed=await fileTool('fs_find',{path:root,includeDirectories:true,respectIgnore:false,includeHidden:true,glob:['**/leaf'],maxResults:30});
 assert.ok(globbed.entries.some(x=>x.path===emptyDir),'directory path glob must work');

 await assert.rejects(()=>fileTool('fs_edit',{path:nested,mode:'replace',oldText:'head',newText:'foo',expectedHash:sha('wrong')}),
   e=>e.code==='FILE_VERSION_CONFLICT'&&e.partialResult.currentSha256===sha(readFileSync(nested)));
 const dry=await fileTool('fs_edit',{path:nested,mode:'replace',oldText:'example',newText:'changed',dryRun:true});
 assert.match(dry.diff,/\+changed/);
 assert.match(readFileSync(nested,'utf8'),/example/);
 writeFileSync(nested,'one\ntwo\none\ntwo\n');
 await assert.rejects(()=>fileTool('fs_edit',{path:nested,mode:'replace',oldText:'one\ntwo',newText:'X'}),
   e=>e.message.includes('candidateLines=1,3'));
 const err=normalizeToolError(Object.assign(new Error('ENOENT: missing'),{code:'ENOENT'}));
 assert.equal(err.code,'ENOENT');
 const mismatch=normalizeToolError(new Error('REPLACEMENT_COUNT_MISMATCH exact=0'));
 assert.equal(mismatch.code,'REPLACEMENT_COUNT_MISMATCH');
 console.log('PASS structured errors, current SHA, candidate lines, dry-run diff, createParents, field aliases, directory search');

 const fg=await supervisor.foreground('reliability-stdin','检查前台 stdin 默认 EOF',
   {mode:'program',program:'node',args:['-e',"process.stdin.resume();process.stdin.on('end',()=>console.log('EOF-received'))"]},8000);
 assert.equal(fg.exitCode,0);
 assert.match(fg.stdout,/EOF-received/);
 const input=await supervisor.foreground('reliability-stdin-input','检查显式 stdin',
   {mode:'program',program:'node',args:['-e',"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log('DATA='+s))"],stdin:'hello-input'},8000);
 assert.match(input.stdout,/DATA=hello-input/);
 const missing=await supervisor.foreground('reliability-missing','检查找不到程序的诊断',
   {mode:'program',program:'deskbeacon-program-does-not-exist-20261021'},8000);
 assert.ok(missing.spawnError,'missing executable should populate spawnError');
 assert.notEqual(missing.exitCode,0);
 console.log('PASS foreground stdin closes and spawn failure is identifiable');

 const tar=join(root,'sample.tar');
 const zip=join(root,'sample.zip');
 const common={sourcePaths:[nested],maxBytes:1024*1024,overwrite:false};
 const created=await fileTool('fs_archive',{action:'create',format:'tar',outputPath:tar,...common});
 assert.equal(created.sha256,sha(readFileSync(tar)));
 const zipCreated=await fileTool('fs_archive',{action:'create',format:'zip',outputPath:zip,...common});
 assert.ok(zipCreated.sha256);
 const tarEntries=await fileTool('fs_archive',{action:'list',archivePath:tar,limit:20});
 const zipEntries=await fileTool('fs_archive',{action:'list',archivePath:zip,limit:20});
 assert.equal(tarEntries.entries[0].type,'file');
 assert.equal(zipEntries.entries[0].type,'file');
 console.log('PASS tar and zip return consistent list types and SHA256');

 assert.ok(toolInputSchemas.batch_output.safeParse({deviceId:'x',parentOperationId:'op',callId:'child'}).success);
 assert.ok(toolInputSchemas.transfer_download.safeParse({deviceId:'x',description:'retrieve',sourcePath:nested,offset:131072}).success);
 assert.ok(toolInputSchemas.exec_foreground.safeParse({deviceId:'x',description:'stdin',command:{mode:'program',program:'cat',stdin:'payload'}}).success);
 const batch=batchInputSchema.parse({deviceId:'x',description:'error-code',stages:[{calls:[{id:'first',tool:'fs_read',input:{path:'/missing'}}]}]});
 const result=await executeToolBatch(batch,async()=>{throw Object.assign(new Error('ENOENT: expected'),{code:'ENOENT'});});
 assert.equal(result.stages[0].results[0].error.code,'ENOENT');
 console.log('PASS shared schemas and batch error codes');
}finally{
 db.close();
 rmSync(root,{recursive:true,force:true});
}
