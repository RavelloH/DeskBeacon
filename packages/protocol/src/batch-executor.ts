import type { BatchInput, BatchToolName } from './batch.js';

export type BatchInvoke = (tool:BatchToolName,input:Record<string,unknown>,callId:string)=>Promise<Record<string,unknown>>;
export type BatchCallResult = {
  id:string;tool:BatchToolName;ok:boolean;durationMs:number;
  result?:unknown;error?:{code:string;message:string};
  truncated?:boolean;resultBytes?:number;operationId?:string;
};
type BatchStageResult={index:number;parallel:boolean;results:BatchCallResult[];stoppedEarly:boolean};
const clip=(text:string,n=900)=>text.slice(0,n);
function failure(value:Record<string,unknown>):{code:string;message:string}|undefined{
  if(value.isError===true || value.status==='failed'){
    return {code:String(value.code??'TOOL_ERROR'),message:clip(String(value.message??'Tool failed'))};
  }
  const data=value.data as Record<string,unknown>|undefined;
  // A program exiting with a non-zero code is not a transport failure, but
  // it must obey failFast for a useful development workflow.
  if(data && typeof data.exitCode==='number' && data.exitCode!==0){
    return {code:'EXIT_NONZERO',message:'Command exited with code '+data.exitCode};
  }
  if(data && (data.timedOut===true || data.outputLimit===true || data.cancelled===true)){
    return {code:data.timedOut?'COMMAND_TIMEOUT':data.outputLimit?'OUTPUT_LIMIT':'CANCELLED',
      message:'Command did not complete normally'};
  }
}
function bounded(value:Record<string,unknown>,maxBytes:number){
  const json=JSON.stringify(value);
  const size=new TextEncoder().encode(json).byteLength;
  if(size<=maxBytes)return {result:value};
  // The complete result may be available via operation_get/output. Returning
  // an explicit size indicator is safer than silently emitting broken JSON.
  const opId=typeof value.operationId==='string'?value.operationId:undefined;
  return {truncated:true,resultBytes:size,...(opId?{operationId:opId}:{}),
    result:{summary:'Sub-tool output exceeds the batch preview budget; call the tool separately or page its output.',
      ...(opId?{operationId:opId}:{})}};
}
export async function executeToolBatch(
  request:BatchInput,invoke:BatchInvoke,shouldStop:()=>boolean=()=>false
):Promise<{stages:BatchStageResult[];completed:number;failed:number;skipped:number;stoppedEarly:boolean;durationMs:number}>{
  const start=Date.now(),stages:BatchStageResult[]=[];
  const total=request.stages.reduce((count,stage)=>count+stage.calls.length,0);
  let completed=0,failed=0,stop=false;
  const execute=async(call:BatchInput['stages'][number]['calls'][number]):Promise<BatchCallResult>=>{
    const began=Date.now();
    if(shouldStop())return {id:call.id,tool:call.tool,ok:false,durationMs:0,error:{code:'CANCELLED',message:'Batch was cancelled'}};
    // A batch grants exactly the same access to one device as a standalone
    // call. The Agent must not switch devices in nested parameters.
    if('deviceId' in call.input && call.input.deviceId!==request.deviceId){
      failed++;
      return {id:call.id,tool:call.tool,ok:false,durationMs:0,
        error:{code:'CROSS_DEVICE_FORBIDDEN',message:'Nested deviceId must match batch deviceId.'}};
    }
    try{
      const result=await invoke(call.tool,{...call.input,deviceId:request.deviceId},call.id);
      const error=failure(result);
      const output=bounded(result,request.maxResultBytes);
      if(error)failed++;else completed++;
      return {id:call.id,tool:call.tool,ok:!error,durationMs:Date.now()-began,
        ...(error?{error}:{}),...output};
    }catch(e){
      failed++;
      return {id:call.id,tool:call.tool,ok:false,durationMs:Date.now()-began,
        error:{code:'TOOL_EXCEPTION',message:clip(e instanceof Error?e.message:String(e))}};
    }
  };
  for(const [index,stage] of request.stages.entries()){
    if(stop||shouldStop())break;
    const results:BatchCallResult[]=[];
    if(stage.parallel){
      // Parallel means independent calls. The shared device pool alone limits command execution.
      results.push(...await Promise.all(stage.calls.map(execute)));
    }else{
      for(const call of stage.calls){
        const result=await execute(call);
        results.push(result);
        if((stage.failFast&&!result.ok)||shouldStop())break;
      }
    }
    const stoppedEarly=stage.failFast&&results.some(r=>!r.ok);
    stages.push({index,parallel:stage.parallel,results,stoppedEarly});
    if(stoppedEarly)stop=true;
  }
  return {stages,completed,failed,skipped:total-completed-failed,
    stoppedEarly:stop,durationMs:Date.now()-start};
}
