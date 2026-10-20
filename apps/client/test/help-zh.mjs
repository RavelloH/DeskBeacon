import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import stringWidth from 'string-width';
const cli=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true,timeout:12000});
const help=run('help');
assert.equal(help.status,0,help.stderr);
assert.match(help.stdout,/用法：deskbeacon \[命令\] \[选项\]/);
for(const label of ['交互界面','设备与配置','服务管理','维护工具','开发调试（仅开发构建）','全局选项','TUI 操作']) {
 assert.ok(help.stdout.includes(label),'Missing Chinese help group: '+label);
}
for(const command of ['setup','config <name|url>','service <start|stop|restart>','service status [--all|--full]','status [--all|--full]','service logs [领域]','migrate','doctor','update','version','help','demo']) {
 assert.ok(help.stdout.includes(command),'Missing help command: '+command);
}
assert.match(help.stdout,/参数记法：<参数> 必填 · \[参数\] 可选 · \| 表示枚举选项/);
const domains=['service','runtime','connection','execution','migration','security','tui'];
const {demoScenarios}=await import('../dist/demo.js');
for(const domain of domains)assert.ok(help.stdout.includes(domain),'Missing log domain: '+domain);
for(const scenario of [...demoScenarios,'migration','setup','update'])assert.ok(help.stdout.includes(scenario),'Missing Demo scenario: '+scenario);
const helpLines=help.stdout.split(/\r?\n/);
assert.doesNotMatch(help.stdout,/start 会在确实需要升级时先迁移本地存储/);
for(const [command,label,expected] of [
 ['service logs [领域]','领域',domains],
 ['demo [场景]','场景',[...demoScenarios,'migration','setup','update']]
]){
 const rowIndex=helpLines.findIndex(line=>line.includes(command));
 assert.ok(rowIndex>=0,'Missing parent command '+command);
 const child=helpLines[rowIndex+1];
 const markerColumn=child.indexOf('│');
 const parentDescriptionColumn=2+35;
 assert.equal(markerColumn,parentDescriptionColumn,'Vertical guide misaligned: '+child);
 assert.equal(child.trim(),'│ '+label+'：'+expected.join(' | '));
 assert.notEqual(helpLines[rowIndex+2]?.trim().startsWith('│'),true,'No enum wrapping');
}
const descriptions=help.stdout.split(/\r?\n/).filter(line=>/^  \S.*\s{2,}\S/.test(line));
const starts=descriptions.map(line=>{
 const parts=/^  (.+?)( {2,})(\S.*)$/.exec(line);
 assert.ok(parts,'Help row must have aligned columns: '+line);
 return stringWidth('  '+parts[1]+parts[2]);
});
assert.ok(starts.every(start=>start===starts[0]),'Chinese/ASCII descriptions should align visually: '+starts);
for(const flag of ['-h','--help']) {
 const result=run(flag);
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,help.stdout);
}
console.log('PASS Chinese CLI help groups, Unicode-aligned columns, complete commands and help aliases');
