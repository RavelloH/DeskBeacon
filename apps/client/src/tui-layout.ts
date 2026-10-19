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
 const measured=stringWidth(text);
 if(measured<=size)return text+(pad?' '.repeat(size-measured):'');
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
// Reuse Intl formatters: repeatedly constructing toLocaleTimeString formatting
// machinery dominates column-width scans for large activity histories.
const activityClock=new Intl.DateTimeFormat('zh-CN',{hour:'numeric',minute:'numeric',second:'numeric',hour12:false});
const activityShortClock=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
export function activityTime(value:number,now=Date.now()):string{
 const date=new Date(value),today=new Date(now),prev=new Date(now);
 prev.setDate(prev.getDate()-1);
 const same=(a:Date,b:Date)=>a.getFullYear()===b.getFullYear()&&
  a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
 const hm=activityShortClock.format(date);
 if(same(date,today))return activityClock.format(date);
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
export function tableColumns(width:number,timeWidth=9,resultTransfer=0):Column[]{
 const available=Math.max(1,width-2),columns:Column[]=[];
 const structuralWidth=available+Math.max(0,resultTransfer);
 const add=(key:Column['key'],title:string,width:number)=>columns.push({key,title,width});
 if(structuralWidth>=54)add('time','TIME',Math.min(16,Math.max(9,timeWidth)));
 add('state','S',2);
 // Keep AGENT visible even when a terminal is narrow; don't collapse identity.
 add('agent','AGENT',structuralWidth>=78?9:structuralWidth>=50?7:Math.max(3,Math.min(6,Math.floor(structuralWidth*.23))));
 if(structuralWidth>=35)add('tool','TOOL',structuralWidth>=110?10:9);
 if(structuralWidth>=54)add('elapsed','DUR',6);
 const remaining=Math.max(1,available-columns.reduce((n,c)=>n+c.width,0));
 // Preserve ACTION exactly when columns are transferred from RESULT to DETAIL.
 const initialRemaining=remaining+Math.max(0,resultTransfer);
 const initialResult=initialRemaining>=28?Math.max(12,Math.floor(initialRemaining*.37)):0;
 const result=initialResult?Math.max(0,initialResult-Math.max(0,resultTransfer)):0;
 add('action','ACTION',remaining-result);
 if(result)add('result','RESULT',result);
 return columns;
}
/** Only count lines outside the visible DETAIL viewport. */
export function detailScrollStatus(totalLines:number,visibleRows:number,offset=0):string{
 const scrollable=Math.max(0,totalLines-Math.max(0,visibleRows));
 return scrollable>0?Math.max(0,Math.min(scrollable,offset))+' / '+scrollable:'';
}
export function paneLayout(width:number,height:number,terminalHeight=height,timeWidth=9){
 const sideBySide=width>=96&&width>terminalHeight;
 const activityHeight=sideBySide?height:Math.max(3,Math.floor((height-1)*.55));
 const originalActivityWidth=sideBySide?Math.max(1,Math.floor((width-1)*.72)):width;
 const originalResult=sideBySide?
  (tableColumns(Math.max(1,originalActivityWidth-2),timeWidth).find(c=>c.key==='result')?.width??0):0;
 // Take at most four cells from RESULT, never from ACTION, preserving at least 10 RESULT cells.
 const detailGain=sideBySide?Math.min(4,Math.max(0,originalResult-10)):0;
 const activityWidth=originalActivityWidth-detailGain;
 return {sideBySide,activityWidth,detailWidth:sideBySide?Math.max(1,width-1-activityWidth):width,
  activityHeight,detailHeight:sideBySide?height:Math.max(1,height-1-activityHeight),detailGain};
}
