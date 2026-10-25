import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export function localSecret(){
 for(const relative of ['../../../.dev.vars','../.dev.vars']){
  try{
   const body=readFileSync(new URL(relative,import.meta.url),'utf8');
   const line=body.split(/\r?\n/).find(row=>row.startsWith('MCP_AUTH_SECRET='));
   if(line)return line.slice('MCP_AUTH_SECRET='.length).replace(/^"|"$/g,'');
  }catch{}
 }
 return 'local-integration-only';
}
const fnv=(s,h=2166136261)=>{for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h+=(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)}return h>>>0};
const prng=(state,len)=>{let s='';while(s.length<len){state^=state<<13;state^=state>>>17;state^=state<<5;state>>>=0;s+=state.toString(16).padStart(8,'0')}return s.slice(0,len)};
export async function solveCap(base){
 const response=await fetch(base+'/cap/challenge',{method:'POST'});
 if(!response.ok)throw Error('Cap challenge failed: '+response.status);
 const challenge=await response.json(),seed=fnv(challenge.token),solutions=[];
 for(let i=0;i<challenge.challenge.c;i++){
  const saltSeed=fnv(String(i+1),seed),targetSeed=fnv('d',saltSeed);
  const salt=prng(saltSeed,challenge.challenge.s),target=prng(targetSeed,challenge.challenge.d);
  let attempt=0;
  while(!createHash('sha256').update(salt+attempt).digest('hex').startsWith(target))attempt++;
  solutions.push(attempt);
 }
 const verified=await fetch(base+'/cap/redeem',{method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({token:challenge.token,solutions})
 });
 const value=await verified.json();
 if(!value.success)throw Error('Cap solve failed: '+verified.status);
 return value.token;
}
