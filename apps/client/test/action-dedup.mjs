import assert from 'node:assert/strict';
import {toolRow} from '../dist/tool-presentation.js';
const present=(tool,input,description='A tool action')=>{
 const entry={id:'sample',tool,time:Date.now(),status:'completed',description,
 request_json:JSON.stringify(input),result:'{"data":{}}'};
 const row=toolRow(entry);
 return {tool:row.toolLabel,action:row.action.map(x=>x.text).join('')};
};
assert.deepEqual(present('fs_read',{path:'E:\\project\\alpha.ts',lineOffset:310}),
 {tool:'文件读取',action:'alpha.ts · 第 311 行起'});
assert.deepEqual(present('fs_write',{path:'E:\\project\\alpha.ts',mode:'create'}),
 {tool:'文件写入',action:'alpha.ts · create'});
assert.deepEqual(present('fs_edit',{path:'E:\\project\\alpha.ts',mode:'patch'}),
 {tool:'文件编辑',action:'alpha.ts · patch'});
assert.deepEqual(present('fs_manage',{action:'rename',path:'foo.txt',destination:'bar.txt'}),
 {tool:'文件管理',action:'foo.txt → bar.txt · rename'});
assert.deepEqual(present('fs_list',{path:'E:\\project',depth:2}),
 {tool:'目录列表',action:'E:\\project · 深度 2'});
assert.deepEqual(present('fs_grep',{pattern:'TODO',path:'src'}),
 {tool:'内容搜索',action:'TODO · src'});
assert.deepEqual(present('http_request',{method:'POST',url:'https://example.com/api?q=secret'}),
 {tool:'HTTP 请求',action:'POST · https://example.com/api'});
assert.deepEqual(present('exec_foreground',{command:{mode:'shell',script:'pwd'}},'Build temporary firmware'),
 {tool:'命令执行',action:'Build temporary firmware'});
for(const name of ['fs_write','fs_read','fs_edit','fs_manage','fs_grep','fs_list','fs_find',
 'device_list','device_info','background_output','operation_get']){
 const {action}=present(name,{path:'test.txt',pattern:'TODO',action:'copy'});
 assert.ok(!/^(?:创建|写入|读取|修改|列出|查找|搜索|查看|查询|检查|执行|停止)\s/.test(action),
  'non-command action repeats an operation verb: '+name+' '+action);
}
console.log('PASS non-command ACTION describes targets and parameters while command description is preserved');
