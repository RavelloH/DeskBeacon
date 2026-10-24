import {describe,it,expect} from 'vitest';
import {handlePairRequest} from '../src/pairing.js';
import type {Env} from '../src/env.js';
import type {OAuthHelpers} from '@cloudflare/workers-oauth-provider';

const origin='https://beacon.example.test';
const challenge='a'.repeat(43);
const make=()=>{
 const data=new Map<string,string>();
 const env={OAUTH_KV:{
  get:async(key:string,mode?:string)=>{const value=data.get(key);return mode==='json'?(value?JSON.parse(value):null):value??null;},
  put:async(key:string,value:string)=>{data.set(key,value);},
  delete:async(key:string)=>{data.delete(key);}
 }} as unknown as Env;
 const oauth={lookupClient:async(clientId:string)=>clientId==='client-1'?{
  clientId,redirectUris:[origin+'/pair/callback'],grantTypes:['authorization_code','refresh_token'],
  tokenEndpointAuthMethod:'none',responseTypes:['code']
 }:null} as unknown as OAuthHelpers;
 const req=(path:string,method='GET',body?:BodyInit)=>
  handlePairRequest(new Request(origin+path,{method,...(body?{body}:{})}),env,oauth,origin);
 const post=(path:string,value:object)=>req(path,'POST',JSON.stringify(value));
 return{env,oauth,req,post,data};
};
describe('Headless device pairing relay',()=>{
 it('requires a registered public OAuth client with the exact Worker callback and PKCE',async()=>{
  const {post,req,oauth}=make();
  expect((await post('/pair/start',{client_id:'unknown',code_challenge:challenge,device_name:'VPS'})).status).toBe(403);
  expect((await post('/pair/start',{client_id:'client-1',code_challenge:'weak',device_name:'VPS'})).status).toBe(400);
  expect((await req('/pair/start')).status).toBe(405);
  const other={lookupClient:async()=>({clientId:'client-1',redirectUris:['https://attacker.test/callback'],grantTypes:['authorization_code'],tokenEndpointAuthMethod:'none'})} as unknown as OAuthHelpers;
  expect((await handlePairRequest(new Request(origin+'/pair/start',{method:'POST',body:JSON.stringify({client_id:'client-1',code_challenge:challenge,device_name:'VPS'})}),{...make().env},other,origin)).status).toBe(403);
 });
 it('completes browser consent via OAuth authorization code without issuing any bearer tokens',async()=>{
  const {req,post}=make();
  const start=await post('/pair/start',{client_id:'client-1',code_challenge:challenge,device_name:'VPS'});
  expect(start.status).toBe(200);
  const data=await start.json() as {device_code:string;user_code:string;verification_uri:string;expires_in:number};
  expect(data.device_code.length).toBeGreaterThan(35);
  expect(data.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(data.verification_uri).toBe(origin+'/activate');
  expect(JSON.stringify(data)).not.toContain('access_token');
  const pending=await post('/pair/poll',{device_code:data.device_code});
  expect(pending.status).toBe(202);
  expect((await pending.json() as {status:string}).status).toBe('pending');
  expect((await req('/activate')).status).toBe(200);
  const activation=await req('/activate','POST',new URLSearchParams({code:data.user_code}));
  expect(activation.status).toBe(303);
  const redirect=new URL(activation.headers.get('location')!);
  expect(redirect.pathname).toBe('/authorize');
  expect(redirect.searchParams.get('client_id')).toBe('client-1');
  expect(redirect.searchParams.get('redirect_uri')).toBe(origin+'/pair/callback');
  expect(redirect.searchParams.get('code_challenge')).toBe(challenge);
  expect(redirect.searchParams.get('scope')).toBe('deskbeacon:device');
  const callback=await req('/pair/callback?state='+redirect.searchParams.get('state')+'&code=authorization-code-123');
  expect(callback.status).toBe(200);
  const accepted=await post('/pair/poll',{device_code:data.device_code});
  expect(await accepted.json()).toMatchObject({status:'authorized',code:'authorization-code-123'});
  expect((await req('/activate','POST',new URLSearchParams({code:data.user_code}))).status).toBe(400);
  expect((await req('/pair/callback?state='+redirect.searchParams.get('state')+'&code=again')).status).toBe(400);
 });
 it('prevents guessed codes, wrong polling secrets and handles denial without code leakage',async()=>{
  const {req,post}=make();
  const start=await post('/pair/start',{client_id:'client-1',code_challenge:challenge,device_name:'Headless'});
  const data=await start.json() as {device_code:string;user_code:string};
  const wrong=await req('/activate','POST',new URLSearchParams({code:'ZZZZ-ZZZZ'}));
  expect(wrong.status).toBe(400);
  const forged=await post('/pair/poll',{device_code:'A'.repeat(43)});
  expect(forged.status).toBe(410);
  expect((await req('/pair/callback?state=invalid&code=1234567890')).status).toBe(400);
  const activation=await req('/activate','POST',new URLSearchParams({code:data.user_code}));
  const state=new URL(activation.headers.get('location')!).searchParams.get('state');
  expect((await req('/pair/callback?state='+state+'&error=access_denied')).status).toBe(200);
  expect(await (await post('/pair/poll',{device_code:data.device_code})).json()).toMatchObject({status:'denied'});
 });
 it('returns expired for pairing sessions past expiry and never reuses invalid callback state',async()=>{
  const {post,data,req}=make();
  const start=await post('/pair/start',{client_id:'client-1',code_challenge:challenge,device_name:'VPS'});
  const body=await start.json() as {device_code:string;user_code:string};
  const kvKey=[...data.keys()].find(k=>k.startsWith('pair:session:'))!;
  data.set(kvKey,JSON.stringify({...JSON.parse(data.get(kvKey)!),expiresAt:Date.now()-1}));
  expect((await post('/pair/poll',{device_code:body.device_code})).status).toBe(410);
  expect((await req('/activate','POST',new URLSearchParams({code:body.user_code}))).status).toBe(400);
 });
});
