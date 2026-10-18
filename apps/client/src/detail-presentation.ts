import {activityPresentation,detailLines,type ActivityEntry} from './presenter.js';
import {toolRow,type Tone,type Segment} from './tool-presentation.js';
import {cellWidth,wrapLines} from './tui-layout.js';
export type DetailLine={text:string;tone?:Tone;bold?:boolean};
const raw=(text:string,tone:Tone='default',bold=false):DetailLine=>({text,tone,bold});
const asText=(parts:Segment[])=>parts.map(p=>p.text).join('');
const label=(key:string,value:string)=>raw('  '+key+' '.repeat(Math.max(1,11-cellWidth(key)))+value);
const heading=(value:string)=>raw('  ── '+value+' ─────','muted',true);
const looksSensitive=(line:string)=>/^\s*(?:环境变量|请求正文|请求头|上传数据|文件内容|图像数据|输入内容)/.test(line);
function sanitize(line:string):string{
 return line.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi,'$1 [redacted]')
  .replace(/\b(password|passwd|authorization|secret|token|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]');
}
function toneFor(line:string):Tone{
 if(/^(?:\s*错误[:：]|\s*✗|\s*−|\s*- (?!-))/.test(line))return 'danger';
 if(/^(?:\s*\+|\s*✓)/.test(line))return 'success';
 if(/截断|结果未知|未完成|超时|已隐藏|输出上限/.test(line))return 'warning';
 if(/^\s*(?:stdout|stderr|历史输出预览|命令输出|退出码)[:：·]/.test(line))return 'muted';
 return 'default';
}
export function detailPresentation(a:ActivityEntry,now:number):DetailLine[]{
 const model=activityPresentation(a,now),visual=toolRow(a);
 const result=detailLines(a);
 const statusIndex=result.findIndex(line=>line.startsWith('状态：'));
 const before=result.slice(0,statusIndex<0?result.length:statusIndex)
  .filter(line=>!['来源：','目录：','意图：','目标：'].some(label=>line.startsWith(label)));
 const after=statusIndex<0?[]:result.slice(statusIndex+1);
 const out:DetailLine[]=[
  heading('OVERVIEW'),
  label('工具',visual.toolLabel),
  label('Tool ID',a.tool),
  label('Agent',model.agent),
  label('时间',new Date(a.time).toLocaleString('zh-CN',{hour12:false})),
  label('状态',model.status),
  label('耗时',model.elapsed),
  ...(a.cwd?[label('目录',a.cwd)]:[]),
  raw(''),
  heading('ACTION'),
  raw('  '+asText(visual.action)),
  ...before.map(line=>raw('  '+sanitize(line),looksSensitive(line)?'muted':toneFor(line))),
  raw(''),
  heading('RESULT'),
  raw('  '+asText(visual.result),visual.result[0]?.tone??'muted'),
  ...after.map(line=>raw('  '+sanitize(line),looksSensitive(line)?'muted':toneFor(line))),
  raw(''),
  label('操作 ID',a.id),
 ];
 return out;
}
export function wrapDetail(lines:DetailLine[],width:number):DetailLine[]{
 return lines.flatMap(line=>wrapLines([line.text],width).map(text=>({...line,text})));
}
