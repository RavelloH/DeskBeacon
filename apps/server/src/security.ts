import {generateChallenge,validateChallenge} from "capjs-core";
import type {Env} from "./env.js";

const utf8=new TextEncoder();
const TTL=2*60*60*1000;
const PROOF_TTL=120_000;
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const unb64=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"=")),ch=>ch.charCodeAt(0));
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
const equal=(left:string,right:string):boolean=>{
 const a=utf8.encode(left),b=utf8.encode(right);
 let mismatch=a.length^b.length;
 for(let n=0;n<Math.max(a.length,b.length);n++)mismatch|=(a[n]??0)^(b[n]??0);
 return mismatch===0;
};
async function master(secret:string,purpose:string):Promise<CryptoKey>{
 const source=utf8.encode("deskbeacon:"+purpose+":v1:"+secret);
 const bytes=await crypto.subtle.digest("SHA-256",source);
 return crypto.subtle.importKey("raw",bytes,{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
async function capSecret(secret:string):Promise<string>{
 const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",utf8.encode("deskbeacon:cap-core:v1:"+secret)));
 return [...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
}
type Ticket={v:1;purpose:"cap-proof"|"management";expires:number;id:string};
async function signTicket(secret:string,purpose:Ticket["purpose"],expires:number):Promise<string>{
 const data:Ticket={v:1,purpose,expires,id:crypto.randomUUID()};
 const encoded=b64(utf8.encode(JSON.stringify(data)));
 const sig=await crypto.subtle.sign("HMAC",await master(secret,purpose),utf8.encode(encoded));
 return encoded+"."+b64(new Uint8Array(sig));
}
async function readTicket(secret:string,raw:string,purpose:Ticket["purpose"]):Promise<Ticket|null>{
 if(typeof raw!=="string"||raw.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw))return null;
 try{
  const [data,sig]=raw.split(".");
  if(!data||!sig)return null;
  const valid=await crypto.subtle.verify("HMAC",await master(secret,purpose),unb64(sig),utf8.encode(data));
  if(!valid)return null;
  const obj=JSON.parse(new TextDecoder().decode(unb64(data))) as Ticket;
  if(obj.v!==1||obj.purpose!==purpose||!Number.isSafeInteger(obj.expires)||
     obj.expires<=Date.now()||obj.expires>Date.now()+TTL+10_000||
     typeof obj.id!=="string"||!/^[a-f0-9-]{36}$/.test(obj.id))return null;
  return obj;
 }catch{return null;}
}
export async function consumeOnce(env:Env,id:string,expires:number):Promise<boolean>{
 const until=Math.max(1,Math.ceil(expires-Date.now()));
 if(until<=1)return false;
 const target=env.DEVICE_SESSIONS.get(env.DEVICE_SESSIONS.idFromName("deskbeacon:cap-nonce:v1"));
 const result=await target.fetch("https://device.internal/security/consume",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({id,expires})
 });
 if(!result.ok)return false;
 return ((await result.json()) as {consumed:boolean}).consumed===true;
}
export async function checkProof(env:Env,raw:unknown):Promise<boolean>{
 if(!env.MCP_AUTH_SECRET||typeof raw!=="string")return false;
 const ticket=await readTicket(env.MCP_AUTH_SECRET,raw,"cap-proof");
 if(!ticket)return false;
 return consumeOnce(env,"proof:"+ticket.id,ticket.expires);
}
export function checkSecret(env:Env,provided:string):boolean{
 return Boolean(env.MCP_AUTH_SECRET)&&equal(provided,env.MCP_AUTH_SECRET);
}
export async function issueManagementToken(env:Env):Promise<{token:string;expiresAt:number}>{
 const expiresAt=Date.now()+TTL;
 return {token:await signTicket(env.MCP_AUTH_SECRET,"management",expiresAt),expiresAt};
}
export async function isManager(env:Env,raw:string):Promise<boolean>{
 return Boolean(env.MCP_AUTH_SECRET)&&Boolean(await readTicket(env.MCP_AUTH_SECRET,raw,"management"));
}
export async function rateLimit(request:Request,env:Env,bucket:string):Promise<Response|null>{
 if(!env.SECURITY_RATE_LIMIT)throw Error("SECURITY_RATE_LIMIT binding unavailable");
 const ip=request.headers.get("cf-connecting-ip")||"local";
 const result=await env.SECURITY_RATE_LIMIT.limit({key:bucket+":"+ip});
 return result.success?null:json({error:"rate_limited"},429);
}
export function strictOrigin(request:Request):boolean{
 const origin=request.headers.get("origin");
 return !origin||origin===new URL(request.url).origin;
}
async function boundedJson(request:Request,max=18000):Promise<any>{
 if(Number(request.headers.get("content-length")??0)>max)throw Error("too large");
 const text=await request.text();
 if(utf8.encode(text).byteLength>max)throw Error("too large");
 return JSON.parse(text);
}
export async function capRoute(request:Request,env:Env):Promise<Response>{
 if(request.method!=="POST")return json({error:"method_not_allowed"},405);
 if(!env.MCP_AUTH_SECRET)return json({error:"secret_unconfigured"},503);
 if(!strictOrigin(request))return json({error:"invalid_origin"},403);
 const path=new URL(request.url).pathname;
 const limited=await rateLimit(request,env,path==="\/cap\/challenge"?"cap-challenge":"cap-redeem");
 if(limited)return limited;
 const secret=await capSecret(env.MCP_AUTH_SECRET);
 if(path==="/cap/challenge"){
  const challenge=await generateChallenge(secret,{scope:"deskbeacon:admin",challengeCount:12,challengeDifficulty:4,expiresMs:5*60_000});
  return json(challenge);
 }
 if(path!=="/cap/redeem")return json({error:"not_found"},404);
 let payload:any;
 try{payload=await boundedJson(request);}catch{return json({success:false,error:"invalid_body"},400);}
 const outcome=await validateChallenge(secret,payload,{
  scope:"deskbeacon:admin",tokenTtlMs:PROOF_TTL,
  consumeNonce:async(signature,ttlMs)=>consumeOnce(env,"challenge:"+signature,Date.now()+ttlMs),
  signToken:async({expires})=>signTicket(env.MCP_AUTH_SECRET,"cap-proof",Math.min(expires,Date.now()+PROOF_TTL))
 });
 return json(outcome,outcome.success?200:403);
}
export async function guardSecretRequest(request:Request,env:Env,capToken:unknown):Promise<Response|null>{
 const limited=await rateLimit(request,env,"admin-secret");
 if(limited)return limited;
 if(!strictOrigin(request))return json({error:"invalid_origin"},403);
 return await checkProof(env,capToken)?null:json({error:"invalid_captcha"},403);
}
export async function boundedRequestBody(request:Request,maxBytes=8192):Promise<any>{
 return boundedJson(request,maxBytes);
}
