export type CommandId='help'|'config'|'tasks'|'latest'|'stop'|'view'|'copy'|'quit';
export type Option={label:string;description:string;insert:string;selectable:boolean};
export type Palette={items:Option[];hint:string;stage:'command'|'argument'|'value'};
export type Parsed={id:CommandId;args:string[];value?:string}|{error:string};
const commands:{id:CommandId;description:string}[]=[
{id:'help',description:'显示命令和快捷键帮助'},
{id:'config',description:'查询 / 设置 name 或 url'},
{id:'tasks',description:'打开后台任务列表'},
{id:'latest',description:'选择最新活动记录'},
{id:'stop',description:'停止选中任务或全部任务，需确认'},
{id:'view',description:'切换输入、输出或摘要'},
{id:'copy',description:'复制当前详情'},
{id:'quit',description:'退出 DeskBeacon'}];
const opt=(label:string,description:string,insert:string,selectable=true):Option=>({label,description,insert,selectable});
export function commandPalette(raw:string,config:{name?:string;url?:string}={}):Palette{
 const rest=raw.startsWith('/')?raw.slice(1):raw,space=rest.indexOf(' ');
 if(space<0){
  const needle=rest.trim().toLowerCase();
  return{stage:'command',hint:'输入命令 · ↑↓ 选择 · 空格进入参数 · Enter 执行',
   items:commands.filter(c=>c.id.includes(needle)).map(c=>
    opt('/'+c.id,c.description,'/'+c.id+(['config','view','stop'].includes(c.id)?' ':'')))};
 }
 const head=rest.slice(0,space).toLowerCase(),tail=rest.slice(space+1);
 if(head==='config'){
  const separator=tail.indexOf(' ');
  if(separator<0)return{stage:'argument',hint:'选择配置键 · Enter 查询 · 空格后输入新值',
   items:[opt('name','设备名称：'+(config.name??'未配置'),'/config name '),
    opt('url','服务器地址：'+(config.url??'未配置'),'/config url ')]
     .filter(c=>c.label.includes(tail.toLowerCase()))};
  const key=tail.slice(0,separator).toLowerCase();
  return{stage:'value',hint:key==='name'?'输入新的设备名称 · Enter 同步到服务器':
   '输入服务器 HTTPS URL · Enter 暂存，重新 OAuth 授权后切换',
   items:[opt('<'+(key==='name'?'设备名称':'https://example.com')+'>',
    '当前：'+(key==='name'?config.name??'未配置':config.url??'未配置'),raw,false)]};
 }
 if(head==='view'||head==='stop'){
  const entries=head==='view'?[
   ['summary','普通详情'],['input','全部输入参数'],['output','全部输出或结构化结果'],['stderr','错误输出']]:
   [['selected','停止当前任务，需确认'],['all','停止所有任务，需确认']];
  return{stage:'argument',hint:head==='view'?'选择详情视图 · Enter 执行':'选择停止范围 · Enter 后确认',
   items:entries.filter(([name])=>name.includes(tail.toLowerCase())).map(([name,desc])=>opt(name,desc,'/'+head+' '+name))};
 }
 return{stage:'argument',hint:'此命令不需要参数 · Enter 执行',items:[]};
}
export function parseCommand(raw:string):Parsed{
 if(!raw.startsWith('/'))return{error:'命令必须以 / 开头'};
 const trimmed=raw.slice(1).trim(),match=/^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
 const id=match?.[1]?.toLowerCase() as CommandId,rest=(match?.[2]??'').trim();
 if(!commands.some(c=>c.id===id))return{error:'未知命令：/'+(match?.[1]??'')};
 if(id==='config'){
  const arg=/^(url|name)(?:\s+([\s\S]+))?$/.exec(rest);
  if(!arg)return{error:'用法：/config <name|url> [value]'};
  const value=arg[2]?.trim();
  return{id,args:[arg[1]!],...(value===undefined?{}:{value})};
 }
 if(id==='view'){
  if(!['summary','input','output','stderr'].includes(rest))
   return{error:'用法：/view <summary|input|output|stderr>'};
  return{id,args:[rest]};
 }
 if(id==='stop'){
  if(!['selected','all'].includes(rest))return{error:'用法：/stop <selected|all>'};
  return{id,args:[rest]};
 }
 if(rest)return{error:'/'+id+' 不接受参数'};
 return{id,args:[]};
}
export function normalizeServerUrl(value:string):string{
 let url:URL;
 try{url=new URL(value);}catch{throw Error('无效的服务器 URL');}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/')
  throw Error('服务器地址仅支持完整 origin，不能包含账户、路径、查询参数或锚点');
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))
  throw Error('URL 必须使用 HTTPS，只有本机允许 HTTP');
 return url.origin;
}
