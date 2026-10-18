import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskSupervisor } from '../dist/process.js';

const root=mkdtempSync(join(tmpdir(),'deskbeacon-encoding-'));
const db=new DatabaseSync(join(root,'db.sqlite'));
const supervisor=new TaskSupervisor(db,join(root,'output'));

try {
  const script=`param([string]$Label='默认值')
Write-Output "中文输出：$Label，Ω ✓"
[Console]::Error.WriteLine('中文错误输出 ✓')
`;
  for(const shellProfile of process.platform==='win32'?['powershell','pwsh']:[]) {
    const result=await supervisor.foreground('encoding-'+shellProfile,'UTF-8 PowerShell output',
      {mode:'shell',shellProfile,script},15000);
    assert.equal(result.exitCode,0,JSON.stringify(result));
    assert.ok(result.stdout.includes('中文输出：默认值，Ω ✓'),JSON.stringify(result));
    assert.ok(result.stderr.includes('中文错误输出 ✓'),JSON.stringify(result));
    assert.ok(!result.stderr.includes('CLIXML'),JSON.stringify(result));
    console.log('PASS '+shellProfile+' emits correct UTF-8 stdout and stderr with param()');
  }

  const split=`const x=Buffer.from('中文✓','utf8');process.stdout.write(x.subarray(0,1));setTimeout(()=>process.stdout.write(x.subarray(1)),40);`;
  const result=await supervisor.foreground('encoding-split','UTF-8 chunks',
    {mode:'program',program:process.execPath,args:['-e',split]},15000);
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout,'中文✓');
  console.log('PASS Split multibyte UTF-8 survives stdout data events');
} finally {db.close();rmSync(root,{recursive:true,force:true});}
