import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileTool } from '../dist/filesystem.js';
import { toolInputSchemas } from '../../../packages/protocol/dist/tools.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-remove-'));
const input=(path,recursive)=>toolInputSchemas.fs_manage.parse({
  deviceId:'test',action:'remove',path,...(recursive===undefined?{}:{recursive})
});
try {
  const dir=join(root,'中文目录');
  const child=join(dir,'inner','nested');
  mkdirSync(child,{recursive:true});
  writeFileSync(join(child,'测试.txt'),'some content','utf8');

  await assert.rejects(()=>fileTool('fs_manage',input(dir)),/DIRECTORY_REQUIRES_RECURSIVE/);
  assert.equal(existsSync(join(child,'测试.txt')),true,'non-recursive removal must not delete any files');
  console.log('PASS Directory removal requires explicit recursive:true');

  const removed=await fileTool('fs_manage',input(dir,true));
  assert.equal(removed.ok,true);
  assert.equal(existsSync(dir),false);
  console.log('PASS Recursive removal deletes non-empty nested Unicode directory');

  const single=join(root,'普通文件.txt');
  writeFileSync(single,'content');
  await fileTool('fs_manage',input(single));
  assert.equal(existsSync(single),false);
  console.log('PASS Non-recursive removal still deletes files');

  await assert.rejects(()=>fileTool('fs_manage',input(join(root,'missing'),true)),/ENOENT/);
  console.log('PASS Missing paths report errors instead of success');
} finally { rmSync(root,{recursive:true,force:true}); }
