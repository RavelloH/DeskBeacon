import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import {safeText} from './presenter.js';

const segments = new Intl.Segmenter(undefined, {granularity:'grapheme'});
export const cellWidth = (value:string) => stringWidth(value);
export const oneLine = (value:string) => safeText(value,100_000).replace(/[\r\n\t\u2028\u2029]+/g,' ');
/** Measure terminal cells rather than JS string length, including CJK and emoji. */
export function fit(value:string,width:number,pad=true):string {
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
/** Keep the filename visible when the shared directory prefix is too long. */
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
export type Column={key:'time'|'state'|'agent'|'tool'|'elapsed'|'target'|'summary';title:string;width:number};
export function tableColumns(width:number):Column[]{
 const available=Math.max(1,width-2),columns:Column[]=[];
 const add=(key:Column['key'],title:string,width:number)=>columns.push({key,title,width});
 if(available>=55)add('time','TIME',9);
 add('state','S',2);
 if(available>=38)add('agent','AGENT',available>=90?12:10);
 if(available>=30)add('tool','工具',7);
 if(available>=55)add('elapsed','DUR',8);
 const remaining=Math.max(1,available-columns.reduce((n,c)=>n+c.width,0));
 const summary=remaining>=42?Math.floor(remaining*.43):0;
 add('target','TARGET',remaining-summary);
 if(summary)add('summary','INTENT / RESULT',summary);
 return columns;
}
export function paneLayout(width:number,height:number,terminalHeight=height){
 const sideBySide=width>terminalHeight;
 const activityHeight=sideBySide?height:Math.max(3,Math.floor((height-1)*.53));
 return {sideBySide,
  activityWidth:sideBySide?Math.max(1,Math.floor((width-1)*.62)):width,
  detailWidth:sideBySide?Math.max(1,width-1-Math.floor((width-1)*.62)):width,
  activityHeight,detailHeight:sideBySide?height:Math.max(1,height-1-activityHeight)};
}
