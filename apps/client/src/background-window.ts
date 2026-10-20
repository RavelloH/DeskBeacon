/** The footer uses at most five rows, reserving its last row for overflow. */
export function backgroundWindow<T>(items:readonly T[],selection:number,maxRows=5){
 const rows=Math.max(1,Math.min(5,Math.floor(maxRows)));
 const folded=items.length>rows;
 const capacity=folded?Math.max(1,rows-1):rows;
 const selected=Math.max(0,Math.min(items.length-1,selection));
 const start=Math.max(0,Math.min(
   Math.max(0,selected-capacity+1),Math.max(0,items.length-capacity)
 ));
 const visible=items.slice(start,start+capacity);
 return {start,visible,hidden:items.length-visible.length,rows:visible.length+(folded?1:0)};
}
