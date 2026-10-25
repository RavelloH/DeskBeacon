import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import {generateChallenge} from "capjs-core";
import {capRoute,checkSecret,checkProof,issueManagementToken,isManager,rateLimit} from "../src/security.js";
import {manageRoute} from "../src/manage.js";
import type {Env} from "../src/env.js";
import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";

const secret="valid test-only secret that is at least 32 bytes long";
const origin="https://beacon.example.test";
function fixture(){
 const used=new Set<string>(),rateKeys:string[]=[],revoked:string[]=[],kvWrites:string[]=[],deleted:string[]=[];
 const grants=[
  {id:"grant-agent",clientId:"agent-client",userId:"owner",scope:["deskbeacon:agent"],metadata:{label:"ChatGPT"},createdAt:Date.now()},
  {id:"grant-device",clientId:"device-client",userId:"owner",scope:["deskbeacon:device"],metadata:{label:"Termux"},createdAt:Date.now()}
 ];
 const env={
  MCP_AUTH_SECRET:secret,
  SECURITY_RATE_LIMIT:{limit:async({key}:{key:string})=>{rateKeys.push(key);return{success:true};}},
  OAUTH_KV:{
   get:async()=>null,
   put:async(key:string)=>{kvWrites.push(key);},
   delete:async(key:string)=>{deleted.push(key);}
  },
  DEVICE_SESSIONS:{
   idFromName:(name:string)=>name,
   get:(id:string)=>({
    fetch:async(url:string,options?:RequestInit)=>{
     const pathname=new URL(url).pathname;
     if(pathname==="/security/consume"){
      const body=JSON.parse(String(options?.body)) as {id:string;expires:number};
      const present=used.has(body.id);used.add(body.id);
      return Response.json({consumed:!present},{status:present?409:200});
     }
     if(pathname==="/revoke"){revoked.push(id);return Response.json({revoked:true});}
     if(pathname==="/status")return Response.json({online:true});
     return new Response(null,{status:404});
    }
   })
  }
 } as unknown as Env;
 const oauth={
  listUserGrants:async()=>({items:grants}),
  revokeGrant:async(id:string)=>{const index=grants.findIndex(x=>x.id===id);if(index>=0)grants.splice(index,1);}
 } as unknown as OAuthHelpers;
 return{env,oauth,grants,used,rateKeys,kvWrites,revoked,deleted};
}
async function getSolvedTicket(env:Env){
 const derived=createHash("sha256").update("deskbeacon:cap-core:v1:"+secret).digest("hex");
 const challenge=await generateChallenge(derived,{
  scope:"deskbeacon:admin",format:2,protocols:["sha256-pow"],
  challengeCount:1,challengeDifficulty:1
 });
 const ch=challenge as Extract<typeof challenge,{format:2}>;
 const data=ch.challenges[0]?.payload as {salt:string;target:string};
 let solution=0;
 while(!createHash("sha256").update(data.salt+solution).digest("hex").startsWith(data.target))solution++;
 const payload={token:ch.token,solutions:[{nonce:solution}]};
 const post=()=>capRoute(new Request(origin+"/cap/redeem",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)
 }),env);
 const res=await post();
 expect(res.status).toBe(200);
 const decoded=await res.json() as {token:string;success:boolean};
 expect(decoded.success).toBe(true);
 return{ticket:decoded.token,post};
}
describe("CapJS and state-free admin protection",()=>{
 it("rate limiter uses only Workers binding and does not write OAuth KV",async()=>{
  const {env,rateKeys,kvWrites}=fixture();
  expect(await rateLimit(new Request(origin+"/manage/token"),env,"admin-secret")).toBeNull();
  expect(rateKeys).toEqual(["admin-secret:local"]);
  expect(kvWrites).toEqual([]);
 });
 it("requires Cap proof on every secret-accepting endpoint",async()=>{
  const {env,oauth}=fixture();
  const payload=(secretValue:string,capToken?:string)=>new Request(origin+"/manage/token",{
   method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({secret:secretValue,capToken})
  });
  expect((await manageRoute(payload(secret),env,oauth)).status).toBe(403);
 });
 it("Cap proof cannot be reused and administrator bearer is tamper resistant",async()=>{
  const {env,oauth,kvWrites}=fixture();
  const {ticket,post}=await getSolvedTicket(env);
  expect((await post()).status).toBe(403);
  expect(await checkProof(env,ticket)).toBe(true);
  expect(await checkProof(env,ticket)).toBe(false);
  expect(checkSecret(env,secret)).toBe(true);
  expect(checkSecret(env,secret+"bad")).toBe(false);
  const {token}=await issueManagementToken(env);
  expect(await isManager(env,token)).toBe(true);
  expect(await isManager(env,token.slice(0,-2)+"ee")).toBe(false);
  expect(await isManager({...env,MCP_AUTH_SECRET:"rotated secret"} as Env,token)).toBe(false);
  expect(kvWrites).toEqual([]);
 });
 it("management token requires fresh Cap and is accepted without repeating Cap",async()=>{
  const {env,oauth}=fixture();
  const {ticket}=await getSolvedTicket(env);
  const login=await manageRoute(new Request(origin+"/manage/token",{
   method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({secret,capToken:ticket})
  }),env,oauth);
  expect(login.status).toBe(200);
  const {token}=await login.json() as {token:string};
  const grants=await manageRoute(new Request(origin+"/manage/api/grants?role=agent",{
   headers:{"Authorization":"Bearer "+token}
  }),env,oauth);
  expect(grants.status).toBe(200);
  expect((await grants.json() as {items:{label:string}[]}).items[0]?.label).toBe("ChatGPT");
  expect((await manageRoute(new Request(origin+"/manage/api/grants?role=agent"),env,oauth)).status).toBe(401);
  expect((await manageRoute(new Request(origin+"/manage/api/grants?role=agent",{
   headers:{"Authorization":"Bearer "+token,"Origin":"https://attacker.test"}
  }),env,oauth)).status).toBe(403);
 });
 it("revoke validates grant ownership and terminates device websocket",async()=>{
  const {env,oauth,revoked,deleted}=fixture();
  const {token}=await issueManagementToken(env);
  const headers={"authorization":"Bearer "+token};
  const miss=await manageRoute(new Request(origin+"/manage/api/grants/unknown",{method:"DELETE",headers}),env,oauth);
  expect(miss.status).toBe(404);
  const revoke=await manageRoute(new Request(origin+"/manage/api/grants/grant-device",{method:"DELETE",headers}),env,oauth);
  expect(revoke.status).toBe(200);
  expect(revoked).toEqual(["device-client"]);
  expect(deleted).toEqual(["device:device-client"]);
 });
 it("keeps registration if another Device Grant is still active",async()=>{
  const {env,oauth,grants,revoked,deleted}=fixture();
  grants.push({id:"grant-device-two",clientId:"device-client",userId:"owner",
    scope:["deskbeacon:device"],metadata:{label:"Termux"},createdAt:Date.now()});
  const {token}=await issueManagementToken(env);
  const response=await manageRoute(new Request(origin+"/manage/api/grants/grant-device",{
    method:"DELETE",headers:{"authorization":"Bearer "+token}
  }),env,oauth);
  expect(response.status).toBe(200);
  expect(deleted).toEqual([]);
  expect(revoked).toEqual(["device-client"]);
  expect(grants.find(x=>x.id==="grant-device-two")).toBeTruthy();
 });
 it("does not delete a device record when revoking an Agent Grant",async()=>{
  const {env,oauth,deleted,revoked}=fixture();
  const {token}=await issueManagementToken(env);
  const response=await manageRoute(new Request(origin+"/manage/api/grants/grant-agent",{
    method:"DELETE",headers:{"authorization":"Bearer "+token}
  }),env,oauth);
  expect(response.status).toBe(200);
  expect(deleted).toEqual([]);
  expect(revoked).toEqual([]);
 });
});
