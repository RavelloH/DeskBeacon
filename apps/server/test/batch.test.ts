import {describe,it,expect} from 'vitest';
import {batchInputSchema,toolInputSchemas,TOOL_NAMES} from '@deskbeacon/protocol';
import {executeToolBatch} from '../src/batch.js';
import {dispatchTool} from '../src/api.js';

function parse(stages:unknown,maxResultBytes?:number){
 return batchInputSchema.parse({deviceId:'dev-1',description:'Agent development batch',
   stages,...(maxResultBytes?{maxResultBytes}:{})});
}
describe('General-purpose MCP batch',()=>{
 it('exposes only the universal batch tool alongside foreground commands',()=>{
   expect(TOOL_NAMES).toContain('batch');
   expect(TOOL_NAMES).toContain('exec_foreground');
   expect(TOOL_NAMES).not.toContain('exec_batch');
 });
 it('disallows recursive batches and duplicate IDs while allowing parallel commands',()=>{
   const stage=(calls:any[],parallel=false)=>[{parallel,calls}];
   expect(toolInputSchemas.batch.safeParse({deviceId:'d',description:'x',stages:stage([
     {id:'bad',tool:'batch',input:{}}])}).success).toBe(false);
   expect(toolInputSchemas.batch.safeParse({deviceId:'d',description:'x',stages:stage([
     {id:'twice',tool:'fs_read',input:{path:'x'}},
     {id:'twice',tool:'fs_read',input:{path:'y'}}])}).success).toBe(false);
   expect(toolInputSchemas.batch.safeParse({deviceId:'d',description:'x',stages:stage([
     {id:'write',tool:'fs_write',input:{path:'x',mode:'create',content:'a'}}],true)}).success).toBe(true);
 });
 it('runs independent read tools concurrently and stages sequentially',async()=>{
   const order:string[]=[];
   const request=parse([
     {parallel:true,calls:[
       {id:'read',tool:'fs_read',input:{path:'a'}},
       {id:'grep',tool:'fs_grep',input:{path:'.',pattern:'hello'}}
     ]},
     {calls:[{id:'tests',tool:'exec_foreground',input:{description:'test',command:{mode:'program',program:'node',args:['--test']}}}]}
   ]);
   const output=await executeToolBatch(request,async(tool,input)=>{
     order.push('start:'+tool);await new Promise(resolve=>setTimeout(resolve,10));
     expect(input.deviceId).toBe('dev-1');
     order.push('end:'+tool);
     return {status:'completed',data:{exitCode:0,path:input.path??''}};
   });
   expect(order.slice(0,2)).toEqual(['start:fs_read','start:fs_grep']);
   expect(order.indexOf('start:exec_foreground')).toBeGreaterThan(order.indexOf('end:fs_grep'));
   expect(output.completed).toBe(3);
   expect(output.failed).toBe(0);
   expect(output.stages).toHaveLength(2);
 });
 it('stops after command exit failure, preserving results and skipped count',async()=>{
   const seen:string[]=[];
   const request=parse([
     {calls:[
       {id:'fail',tool:'exec_foreground',input:{description:'f',command:{mode:'program',program:'node'}}},
       {id:'skipped',tool:'fs_read',input:{path:'a'}}]},
     {calls:[{id:'late',tool:'fs_read',input:{path:'b'}}]}
   ]);
   const out=await executeToolBatch(request,async(tool)=>{
     seen.push(tool);return {status:'completed',data:tool==='exec_foreground'?{exitCode:2}:{}};
   });
   expect(out.failed).toBe(1);expect(out.skipped).toBe(2);
   expect(out.stoppedEarly).toBe(true);
   expect(out.stages[0]?.results[0]?.error?.code).toBe('EXIT_NONZERO');
   expect(seen).toEqual(['exec_foreground']);
 });
 it('can continue after errors when failFast is false',async()=>{
   const out=await executeToolBatch(parse([{failFast:false,calls:[
     {id:'one',tool:'fs_read',input:{path:'a'}},
     {id:'two',tool:'fs_stat',input:{paths:['a']}}
   ]}]),async(tool)=>tool==='fs_read'?
      {isError:true,code:'ENOENT',message:'Not found'}:{status:'completed',data:{paths:[]}});
   expect(out.failed).toBe(1);expect(out.completed).toBe(1);expect(out.skipped).toBe(0);
 });
 it('rejects nested cross-device requests without invoking a tool',async()=>{
   let calls=0;
   const out=await executeToolBatch(parse([{calls:[
     {id:'bad',tool:'fs_read',input:{deviceId:'someone-else',path:'a'}}
   ]}]),async()=>{calls++;return {}});
   expect(calls).toBe(0);
   expect(out.stages[0]?.results[0]?.error?.code).toBe('CROSS_DEVICE_FORBIDDEN');
 });
 it('bounds large responses explicitly while retaining an operation reference',async()=>{
   const out=await executeToolBatch(parse([{calls:[
     {id:'big',tool:'fs_read',input:{path:'big-file'}}
   ]}],1024),async()=>({operationId:'op-123',status:'completed',data:{content:'x'.repeat(6000)}}));
   const x=out.stages[0]?.results[0];
   expect(x?.ok).toBe(true);expect(x?.truncated).toBe(true);
   expect(x?.operationId).toBe('op-123');
   expect(JSON.stringify(x)).not.toContain('x'.repeat(200));
 });
 it('does not impose an independent batch command pool or skip active parallel calls',async()=>{
   let active=0,maxActive=0;
   const seen:string[]=[];
   const requests=Array.from({length:6},(_,i)=>({id:'r'+i,tool:'fs_read' as const,input:{path:'f'+i}}));
   const batch=parse([{parallel:true,failFast:true,calls:requests}]);
   const out=await executeToolBatch(batch,async(_tool,input)=>{
     active++;maxActive=Math.max(maxActive,active);
     seen.push(String(input.path));
     await new Promise(resolve=>setTimeout(resolve,10));
     active--;
     return input.path==='f0'?{isError:true,code:'ENOENT',message:'Not found'}:{status:'completed',data:{content:'ok'}};
   });
   expect(maxActive).toBe(6);
   expect(seen).toHaveLength(6);
   expect(out.failed).toBe(1);
   expect(out.skipped).toBe(0);
   expect(out.stoppedEarly).toBe(true);
 });
 it('retains Agent authorization scope, device identity and sub-tool validation',async()=>{
   const seen:any[]=[];
   const env={
     DEVICE_SESSIONS:{
       idFromName:(id:string)=>id,
       get:()=>({fetch:async(_url:string,init:any)=>{
         const request=JSON.parse(init.body);seen.push(request);
         const invalid=JSON.stringify(request.input).includes('unknownParam');
         return Response.json({operationId:request.operationId,status:'completed',
           data:{stages:[],completed:invalid?0:1,failed:invalid?1:0,skipped:0,stoppedEarly:invalid,durationMs:1}});
       }})
     }
   };
   const out=await dispatchTool(env as any,'batch',{deviceId:'dev-1',description:'read',stages:[
     {calls:[{id:'read',tool:'fs_read',input:{path:'src/index.ts',maxBytes:512}}]}
   ]},'grant-42','ChatGPT');
   expect(out.completed).toBe(1);expect(seen).toHaveLength(1);
   expect(seen[0].grantId).toBe('grant-42');
   expect(seen[0].actorName).toBe('ChatGPT');
   expect(seen[0].name).toBe('batch');
   expect(seen[0].input.deviceId).toBe('dev-1');
   expect(seen[0].input.stages[0].calls[0].input.path).toBe('src/index.ts');
   const invalid=await dispatchTool(env as any,'batch',{deviceId:'dev-1',description:'invalid',stages:[
     {calls:[{id:'bad',tool:'fs_read',input:{path:'a',unknownParam:true}}]}
   ]},'grant-42','ChatGPT');
   expect(invalid.failed).toBe(1);
   expect(seen).toHaveLength(2);
 });
});
