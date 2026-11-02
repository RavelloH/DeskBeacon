/** Strict, loss-aware UI text verification. Never strip arbitrary whitespace or prefixes. */
export type TextEquivalence={
 equivalent:boolean;
 exact:boolean;
 eolNormalized:boolean;
 trailingNewlineDropped:boolean;
};
export function compareDesktopText(expected:string,actual:string):TextEquivalence{
 if(expected===actual)return {equivalent:true,exact:true,eolNormalized:false,trailingNewlineDropped:false};
 const canonical=(s:string)=>s.replace(/\r\n?|\n/g,'\n');
 const requested=canonical(expected),observed=canonical(actual);
 if(requested===observed)
  return {equivalent:true,exact:false,eolNormalized:true,trailingNewlineDropped:false};
 if(requested.endsWith('\n')&&requested.slice(0,-1)===observed)
  return {equivalent:true,exact:false,eolNormalized:true,trailingNewlineDropped:true};
 return {equivalent:false,exact:false,eolNormalized:false,trailingNewlineDropped:false};
}
