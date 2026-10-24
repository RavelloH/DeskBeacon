import assert from 'node:assert/strict';
import {TOOL_NAMES} from '../../../packages/protocol/dist/tools.js';
import {toolRow,TOOL_LABELS} from '../dist/tool-presentation.js';
import {detailPresentation,wrapDetail} from '../dist/detail-presentation.js';
import {activityTime,dateDivider,tableColumns,rightFit,paneLayout,cellWidth} from '../dist/tui-layout.js';

const make=(tool,req={},res={},status='completed',description='测试操作')=>({
 id:'test-'+tool,grant_id:'grant',actor_name:'Codex',tool,description,
 status,time:Date.now()-2500,finished_at:Date.now(),duration_ms:2500,cwd:'E:/DeskBeacon',
 request_json:JSON.stringify(req),result:JSON.stringify(res)
});
assert.ok(TOOL_NAMES.length>=35,'unexpected loss of MCP tools');
assert.equal(new Set(TOOL_NAMES).size,TOOL_NAMES.length,'duplicate tool name');
for(const tool of TOOL_NAMES){
 const view=toolRow(make(tool));
 assert.ok(view.toolLabel.length>=2,tool+': missing tool label');
 assert.ok(view.action.length&&view.result.length,tool+': missing segments');
 assert.ok(view.action.every(segment=>typeof segment.text==='string'&&segment.text.length),tool+': invalid action');
 assert.ok(view.result.every(segment=>typeof segment.text==='string'&&segment.text.length),tool+': invalid result');
 assert.ok(!JSON.stringify(view).includes('undefined'),tool+': placeholder leaked');
 assert.ok(TOOL_LABELS[tool],tool+': missing label mapping');
}
console.log('PASS all '+TOOL_NAMES.length+' MCP tools have explicit ACTION / RESULT templates');

const command=make('exec_foreground',{command:{mode:'program',program:'pnpm',args:['test']}},{
 exitCode:0,stdout:'Starting tests...\n12 tests passed\n',durationMs:1900},'completed','执行 TypeScript 类型检查');
const model=toolRow(command);
assert.match(model.action[0].text,/TypeScript/);
assert.equal(model.result[0].text,'12 tests passed');
assert.ok(!JSON.stringify(model.result).includes('1.9s'));
assert.equal(model.result[0].tone,'muted');
const failing=toolRow(make('exec_foreground',{}, {exitCode:1,stderr:'BUILD_FAILED: TS2322\n'},'completed','失败构建'));
assert.match(failing.result[0].text,/退出 1.*TS2322/);
assert.equal(failing.result[0].tone,'danger');
const edited=toolRow(make('fs_edit',{path:'src/a.ts',mode:'replace'}, {changed:true,replacements:2,addedLines:8,removedLines:3,bytes:7373}));
assert.deepEqual(edited.result.filter(s=>s.tone==='success'||s.tone==='danger').map(s=>s.text),['+8','-3']);
assert.match(edited.action[0].text,/a.ts/);
assert.ok(edited.result.some(s=>s.text.includes('7.2KB')),'edit summary should include the modified file size');
assert.ok(!toolRow(make('fs_read',{}, {readBytes:12,truncated:true})).result[0].text.includes('未完'));
console.log('PASS command stdout preview replaces redundant duration and file diff uses colored line deltas');
const auxiliary=toolRow(make('fs_edit',{path:'src/a.ts',mode:'replace'},{}));
assert.ok(auxiliary.action.length>=2);
assert.equal(auxiliary.action[0].text,'a.ts');
assert.equal(auxiliary.action[0].tone,'default');
assert.match(auxiliary.action[1].text,/· replace/);
assert.equal(auxiliary.action[1].tone,'muted');
const streamAction=toolRow(make('background_output',{backgroundTaskId:'abc',stream:'stdout'},{}));
assert.equal(streamAction.action.at(-1).tone,'muted');
assert.ok(streamAction.action.at(-1).text.includes('stdout'));
console.log('PASS ACTION dot-separated auxiliary metadata is muted');


const sensitive=toolRow(make('http_request',{method:'GET',url:'https://user:pass@api.example.com/private?token=secret#section'},{status:200}));
assert.ok(!JSON.stringify(sensitive).includes('secret'));
assert.ok(!JSON.stringify(sensitive).includes('pass'));
const shell=toolRow(make('exec_foreground',{command:{mode:'shell',script:'echo --token=supersecret'}}));
assert.ok(!JSON.stringify(shell).includes('supersecret'));
const interrupted=toolRow(make('exec_foreground',{}, {},'interrupted'));
assert.match(interrupted.result[0].text,/结果未知/);
const detail=detailPresentation(edited==='bad'?command:command,Date.now());
assert.ok(!detail.some(line=>line.section==='OPERATION'),'DETAIL heading replaces duplicate OPERATION heading');
assert.ok(detail.some(line=>line.text.includes('ACTION')));
assert.ok(detail.some(line=>line.text.includes('RESULT')));
assert.ok(wrapDetail(detail,30).every(line=>typeof line.text==='string'));
console.log('PASS secrets are hidden and detail sections handle interruptions');
// Tool-specific structured detail must not degrade to generic operation metadata.
const textOf=view=>view.map(row=>row.text).join('\n');
const fileCreation=detailPresentation(make('fs_write',
 {path:'E:/demo/new.ts',mode:'create',content:'const answer = 42;\n// example\nconsole.log(answer);\n'},
 {writtenBytes:53,sha256:'1234567890'}),Date.now());
assert.ok(textOf(fileCreation).includes('FILE CONTENT'),'file creation must show the authored full text');
assert.ok(textOf(fileCreation).includes('const answer = 42'));
assert.ok(fileCreation.some(row=>row.text.includes('const answer')&&row.syntax?.some(span=>span.text==='const'&&span.color!=='#969696')),
 'TypeScript keyword must be syntax highlighted');
assert.ok(fileCreation.some(row=>row.text.includes('// example')&&row.syntax?.some(span=>span.text.includes('// example')&&span.color==='#747474')),
 'TypeScript comments should use dim comment color');
for(const mode of ['create','rewrite','append']){
 const writtenText='# 项目说明\n这是 **重点**、*备注* 与 `pnpm check`。\n';
 const output=detailPresentation(make('fs_write',
  {path:'E:/docs/README.md',mode,content:writtenText,encoding:'utf8'},
  {writtenBytes:Buffer.byteLength(writtenText)}),Date.now());
 const highlighted=output.filter(row=>row.syntax);
 assert.equal(highlighted.map(row=>row.text).join('\n'),writtenText,
  mode+': DETAIL must show exactly the submitted write text');
 assert.ok(highlighted.some(row=>row.syntax.some(span=>span.text.startsWith('# 项目说明')&&span.color!=='#969696')),
  mode+': Markdown title should be highlighted');
 assert.ok(highlighted.some(row=>row.syntax.some(span=>span.text.includes('**重点**')&&span.color!=='#969696')),
  mode+': Markdown strong text should be highlighted');
 assert.ok(highlighted.some(row=>row.syntax.some(span=>span.text.includes('`pnpm check`')&&span.color!=='#969696')),
  mode+': Markdown inline code should be highlighted');
 assert.ok(output.some(row=>row.section===(mode==='append'?'APPENDED CONTENT':'FILE CONTENT')));
}
const unavailableWrite=detailPresentation(make('fs_write',{path:'file.ts',mode:'create',content:'[redacted]'},{}),Date.now());
assert.ok(unavailableWrite.some(row=>row.text.includes('未保存可预览的写入文本')));
assert.ok(!unavailableWrite.some(row=>row.syntax));
const base64Write=detailPresentation(make('fs_write',{path:'photo.ts',mode:'create',encoding:'base64',content:'Y29uc3QgYQ=='},{}),Date.now());
assert.ok(!base64Write.some(row=>row.syntax),'binary file writes must not be treated as code');
console.log('PASS fs_write create/rewrite/append uses syntax highlighting for the submitted Markdown content');

const exactlyRead='actual line 41\nactual line 42';
const scoped=detailPresentation(make('fs_read',
 {path:'E:/file-outside-test.txt',lineOffset:40,maxLines:2,maxBytes:64},
 {content:exactlyRead,linesRead:2,readBytes:27,totalBytes:100000,truncated:true,lineOffset:40}),
 Date.now());
assert.ok(textOf(scoped).includes('actual line 41')&&textOf(scoped).includes('actual line 42'),'preview must include only the two returned lines');
assert.equal(scoped.filter(row=>/actual line 4[12]/.test(row.text)).length,2,'exactly the requested two lines must appear');
assert.ok(!textOf(scoped).includes('unread line'),'preview must not infer other lines from totalBytes');
const legacyRead=detailPresentation(make('fs_read',{path:'E:/old.txt'},{content:'[redacted]',linesRead:4,readBytes:60}),Date.now());
assert.ok(textOf(legacyRead).includes('未保存此次读取的正文'));
assert.ok(!textOf(legacyRead).includes('[redacted]'),'legacy placeholders are not actual file content');
console.log('PASS scoped file reads display exactly returned content, never re-read or invent full-file text');
const patch=detailPresentation(make('fs_edit',{path:'E:/demo/new.ts',mode:'replace',
 oldText:'const answer = 41;',newText:'const answer = 42;'},
 {replacements:1,addedLines:1,removedLines:1}),Date.now());
assert.ok(textOf(patch).includes('DIFF'));
assert.ok(patch.some(row=>row.text.trimStart().startsWith('+const')&&row.tone==='success'));
assert.ok(patch.some(row=>row.text.trimStart().startsWith('-const')&&row.tone==='danger'));
const matches=detailPresentation(make('fs_grep',{pattern:'answer',path:'E:/demo'},
 {totalMatches:1,matches:[{path:'E:/demo/new.ts',lineNumber:1,text:'const answer = 42;'}]}),Date.now());
assert.ok(matches.some(row=>row.text.includes('new.ts:1')&&row.tone==='muted'),'search result values should be dim unless they carry an explicit error/diff tone');
const commandDetail=detailPresentation(make('exec_foreground',
 {command:{mode:'shell',script:'echo ready'}},
 {exitCode:0,stdout:'ready\n',stderr:'some warning\n'}),Date.now());
assert.ok(textOf(commandDetail).includes('STDOUT'));
assert.ok(textOf(commandDetail).includes('STDERR'));
assert.ok(textOf(commandDetail).includes('COMMAND'));
const secrets=detailPresentation(make('fs_write',
 {path:'a.env',mode:'create',content:'token=supersecret\npassword=topsecret'},
 {writtenBytes:40}),Date.now());
assert.ok(!textOf(secrets).includes('supersecret'));
assert.ok(!textOf(secrets).includes('topsecret'));
for(const width of [8,12,24,40]){
 const wrapped=wrapDetail(fileCreation,width);
 assert.ok(wrapped.every(row=>row.text.length===0||typeof row.text==='string'));
}
const pathValue='E:/very/long/path/with/unicode/目录/and/deeply/nested/field-values/file-with-long-name.ts';
const wrappedField=wrapDetail([{text:pathValue,label:'PATH',tone:'muted'}],22);
assert.ok(wrappedField.length>2,'long detail fields should wrap over multiple rows');
const columnPositions=wrappedField.map(row=>cellWidth(row.text.slice(0,row.text.indexOf('│'))));
assert.equal(new Set(columnPositions).size,1,'every continuation must keep the vertical separator aligned');
assert.ok(wrappedField.every(row=>row.text.includes('│')&&row.label==='PATH'&&row.tone==='muted'),
 'every continuation retains its separator and muted value styling');
assert.ok(wrappedField.slice(1).every(row=>row.text.slice(0,row.text.indexOf('│')).trim()===''),
 'continued field labels must be blank but retain the field column');
console.log('PASS multiline DETAIL fields retain the separator, column alignment and value color');
import {highlightCode,languageForPath,languageForCommand} from '../dist/syntax-highlight.js';
for(const [path,language] of [
 ['main.tsx','typescript'],['component.jsx','javascript'],['main.py','python'],
 ['script.ps1','powershell'],['build.sh','bash'],['install.cmd','dos'],['src/main.rs','rust'],
 ['src/main.go','go'],['src/main.cpp','cpp'],['main.c','c'],
 ['settings.json','json'],['worker.yaml','yaml'],['index.html','xml'],
 ['styles.css','css'],['query.sql','sql'],['README.md','markdown']
])assert.equal(languageForPath(path),language);
assert.equal(languageForPath('randomfile.zzz'),undefined);
assert.equal(languageForCommand({mode:'shell',shellProfile:'powershell'}),'powershell');
assert.equal(languageForCommand({mode:'program',program:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'}),'powershell');
assert.equal(languageForCommand({mode:'shell',shellProfile:'bash'}),'bash');
assert.equal(languageForCommand({mode:'program',program:'cmd.exe'}),'dos');
const samples=[
 ['typescript','const answer = "hello"; // comment','const','"hello"'],
 ['powershell','$name = "hello"; Get-ChildItem -Path .','Get-ChildItem','"hello"'],
 ['bash','echo "hello" && export USER=dev','echo','"hello"'],
 ['python','def greet(name): return "hello"','def','"hello"'],
 ['json','{"ok": true, "count": 42}','"ok"','42']
];
for(const [language,source,keyword,string] of samples){
 const spans=highlightCode(source,language);
 assert.equal(spans.map(s=>s.text).join(''),source,language+': highlight must preserve exact text');
 assert.ok(new Set(spans.map(s=>s.color)).size>1,language+': must have multiple lexical colors');
 assert.ok(spans.some(s=>s.text.includes(keyword)&&s.color!=='#969696'),language+': keyword / function must be colored');
 assert.ok(spans.some(s=>s.text.includes(string)&&s.color!=='#969696'),language+': literal must be colored');
}
const escaped='const test = a < b && c > d && text === "&hello";';
assert.equal(highlightCode(escaped,'typescript').map(s=>s.text).join(''),escaped,
 'HTML markup entities must decode to original source text');
const scriptText='Get-ChildItem -Path "C:\\Users" | Where-Object { $_.Name -like "*.log" }';
const scriptDetail=detailPresentation(make('exec_foreground',
 {command:{mode:'shell',shellProfile:'powershell',script:scriptText}},{}),Date.now());
const commandRows=wrapDetail(scriptDetail,24);
const commandSection=commandRows.findIndex(s=>s.section==='COMMAND');
assert.ok(commandSection>=0,'powershell commands need dedicated code section');
const commandColors=commandRows.slice(commandSection+2).filter(s=>s.syntax);
assert.ok(commandColors.length>=2,'long command must retain syntax on wrapped rows');
assert.ok(commandColors.some(row=>row.syntax.some(span=>span.color!=='#969696')));
assert.ok(commandColors.every(row=>row.syntax.map(s=>s.text).join('')===row.text),
 'wrapped syntax spans must reconstruct every displayed row without loss');
assert.ok(commandColors.every(row=>cellWidth(row.text)<=24));
const readSyntax=detailPresentation(make('fs_read',
 {path:'src/worker.ts',lineOffset:40,maxLines:2},
 {content:'const token = 42;\nconsole.log("test");',linesRead:2,readBytes:39}),Date.now());
assert.ok(readSyntax.some(row=>row.text.startsWith('const token')&&row.syntax?.some(s=>s.text==='const'&&s.color!=='#969696')),
 'fs_read previews should select grammar from requested path');
assert.ok(!readSyntax.some(row=>row.text.includes('unread contents')));
assert.ok(patch.some(row=>row.text.trimStart().startsWith('+const')&&row.tone==='success'&&!row.syntax),
 'diff semantic colors must take precedence over lexical syntax highlighting');
console.log('PASS Shell/PowerShell and common-language syntax highlighting, ANSI-safe spans, line wraps and diff preservation');
console.log('PASS tool-specific colored FILE / DIFF / SEARCH / COMMAND panels and secret redaction');


const today=Date.now(),yesterday=today-86400000*2;
assert.match(activityTime(today,today),/^\d\d:\d\d:\d\d$/);
assert.ok(activityTime(yesterday,today).includes('-'));
assert.equal(rightFit('5s',6),'    5s');
assert.ok(tableColumns(130).some(c=>c.title==='TOOL'));
assert.ok(tableColumns(130).some(c=>c.title==='ACTION'));
assert.ok(tableColumns(130).some(c=>c.title==='RESULT'));
assert.ok(paneLayout(130,28).activityWidth>paneLayout(130,28).detailWidth);
console.log('PASS adaptive time, TOOl label, right-aligned duration and wider activity pane');
