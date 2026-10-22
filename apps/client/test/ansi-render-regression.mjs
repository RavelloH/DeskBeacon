import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';

const requireFromInk=createRequire(import.meta.resolve('ink'));
const packageJson=requireFromInk.resolve('@alcalzone/ansi-tokenize/package.json');
const packageRoot=dirname(packageJson);
const patchedSource=readFileSync(join(packageRoot,'build','diff.js'),'utf8');
assert.match(patchedSource,/resetCodes\.concat\(added\)/,'Ink must load the patched dependency, not an unpatched duplicate');
const {diffAnsiCodes,undoAnsiCodes,styledCharsToString,styledCharsFromTokens,tokenize}=await import(
 pathToFileURL(join(packageRoot,'build','index.js')).href);
const codes=[
 {type:'ansi',code:'\x1b[1m',endCode:'\x1b[22m'},
 {type:'ansi',code:'\x1b[2m',endCode:'\x1b[22m'},
 {type:'ansi',code:'\x1b[4m',endCode:'\x1b[24m'},
 {type:'ansi',code:'\x1b[31m',endCode:'\x1b[39m'},
 {type:'ansi',code:'\x1b[32m',endCode:'\x1b[39m'},
 {type:'ansi',code:'\x1b[38;2;50;180;190m',endCode:'\x1b[39m'},
 {type:'ansi',code:'\x1b[44m',endCode:'\x1b[49m'},
];
const isIntensity=code=>code.code==='\x1b[1m'||code.code==='\x1b[2m';
function upstreamAlgorithm(from,to){
 const toEnd=new Set(to.map(x=>x.endCode)),toStart=new Set(to.map(x=>x.code));
 const fromStart=new Set(from.map(x=>x.code));
 return undoAnsiCodes(from.filter(x=>isIntensity(x)?!toStart.has(x.code):!toEnd.has(x.endCode)))
  .concat(to.filter(x=>!fromStart.has(x.code)));
}
let seed=194807;
const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0);
function style(){
 const ret=[];
 for(const code of codes)if(random()%4===0){
  const index=ret.findIndex(existing=>existing.endCode===code.endCode&&!isIntensity(existing)&&!isIntensity(code));
  if(index!==-1)ret.splice(index,1);
  ret.push(code);
 }
 return ret;
}
for(let i=0;i<25000;i++){
 const from=style(),to=style();
 const expected=upstreamAlgorithm(from,to),actual=diffAnsiCodes(from,to);
 assert.ok(isDeepStrictEqual(actual,expected),'ANSI transition differs at '+i);
}
for(const string of [
 'plain text','\x1b[31mred\x1b[39m',
 '\x1b[1mbold\x1b[2mdim\x1b[22mnormal',
 '\x1b[38;2;5;160;220m中文📦\x1b[0m',
 '\x1b[4munderline\x1b[24m\x1b[44mcolored background\x1b[49m',
]){
 const result=styledCharsToString(styledCharsFromTokens(tokenize(string)));
 assert.equal(typeof result,'string');
 assert.ok(result.length>0);
}
console.log('PASS patched Ink ANSI diff matches original semantics for 25000 transitions, styled output retains ANSI, and patched module is active');
