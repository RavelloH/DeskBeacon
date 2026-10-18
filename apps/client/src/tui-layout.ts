import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import {safeText} from './presenter.js';

const segments=new Intl.Segmenter(undefined,{granularity:'grapheme'});
export const cellWidth=(value:string)=>stringWidth(value);
export const oneLine=(value:string)=>safeText(value,100_000).replace(/[\r\n\t\u2028\u2029]+/g,' ');
/** Grapheme-aware clipping: keep a terminal cell for the ellipsis. */
export function fit(value:string,width:number,pad=true):string{
 const size=Math.max(0,Math.floor(width)),text=oneLine(value);
 if(!size)return '';
 if(stringWidth(text)<=size)return text+(pad?' '.repeat(size-stringWidth(text)):'');
 let result='',used=0;
 for(const {segment} of segments.segment(text)){
  const length=stringWidth(segment);
  if(used+length>size-1)break;
  result+=segment;used+=length;
 }
 return result+'…'+(pad?' '.repeat(Math.max(0,size-used-1)):'');
}
export function fitPath(value:string,width:number):string{
 const text=oneLine(value);
 if(cellWidth(text)<=width)return fit(text,width);
 let tail='',used=0;
 for(const part of [...segments.segment(text)].reverse()){
  const length=cellWidth(part.segment);
  if(used+length>width-1)break;
  tail=part.segment+tail;used+=length;
 }
 return fit('…'+tail,width);
}
export function wrapLines(lines:string[],width:number):string[]{
 return lines.flatMap(line=>wrapAnsi(safeText(line,100_000).replace(/\r/g,''),Math.max(1,width),
  {hard:true,trim:false,wordWrap:false}).split('\n'));
}
export function rightFit(value:string,width:number):string{
 const clipped=fit(value,width,false);
 return ' '.repeat(Math.max(0,width-cellWidth(clipped)))+clipped;
}
export function activityTime(value:number,now=Date.now()):string{
 const date=new Date(value),today=new Date(now),prev=new Date(now);
 prev.setDate(prev.getDate()-1);
 const same=(a:Date,b:Date)=>a.getFullYear()===b.getFullYear()&&
  a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
 const hm=date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
 if(same(date,today))return date.toLocaleTimeString('zh-CN',{hour12:false});
 if(same(date,prev))return '昨天 '+hm;
 const two=(n:number)=>String(n).padStart(2,'0');
 const datePrefix=date.getFullYear()===today.getFullYear()
  ? two(date.getMonth()+1)+'-'+two(date.getDate())
  :two(date.getFullYear()%100)+'-'+two(date.getMonth()+1)+'-'+two(date.getDate());
 return datePrefix+' '+hm;
}
export function dateKey(value:number):string{
 const d=new Date(value);
 return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
export function dateDivider(value:number,now=Date.now()):string{
 const key=dateKey(value),today=dateKey(now),yesterday=new Date(now);
 yesterday.setDate(yesterday.getDate()-1);
 return key+(key===today?' · 今天':key===dateKey(yesterday.getTime())?' · 昨天':'');
}
export type Column={key:'time'|'state'|'agent'|'tool'|'elapsed'|'action'|'result';title:string;width:number};
export function tableColumns(width:number):Column[]{
 const available=Math.max(1,width-2),columns:Column[]=[];
 const add=(key:Column['key'],title:string,width:number)=>columns.push({key,title,width});
 if(available>=54)add('time','TIME',15);
 add('state','S',2);
 if(available>=63)add('agent','AGENT',available>=105?11:9);
 if(available>=35)add('tool','TOOL',available>=90?13:11);
 if(available>=54)add('elapsed','DUR',8);
 const remaining=Math.max(1,available-columns.reduce((n,c)=>n+c.width,0));
 const result=remaining>=28?Math.max(12,Math.floor(remaining*.37)):0;
 add('action','ACTION',remaining-result);
 if(result)add('result','RESULT',result);
 return columns;
}
export function paneLayout(width:number,height:number,terminalHeight=height){
 const sideBySide=width>=96&&width>terminalHeight;
 const activityHeight=sideBySide?height:Math.max(3,Math.floor((height-1)*.55));
 const activityWidth=sideBySide?Math.max(1,Math.floor((width-1)*.72)):width;
 return {sideBySide,activityWidth,detailWidth:sideBySide?Math.max(1,width-1-activityWidth):width,
  activityHeight,detailHeight:sideBySide?height:Math.max(1,height-1-activityHeight)};
}
