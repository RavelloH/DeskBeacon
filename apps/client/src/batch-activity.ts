/** Retain useful, bounded structure for large Batch activity history.
 * The complete input and result remain in the existing local receipt files.
 */
type Json = Record<string,any>;
const truncate = (value:unknown,max:number):unknown => {
  if(typeof value==='string')return value.length>max?value.slice(0,max)+' ...已截断':value;
  if(Array.isArray(value))return [...value.slice(0,6).map(v=>truncate(v,max)),
    ...(value.length>6?['...剩余 '+(value.length-6)+' 项']:[])];
  return value&&typeof value==='object'?'[structured value]':value;
};

export function batchActivityInput(input:Json,regularPreview:string):string {
  if(regularPreview.length<=6000)return regularPreview;
  const stages=Array.isArray(input.stages)?input.stages:[];
  return JSON.stringify({
    deviceId:input.deviceId,description:input.description,previewLimited:true,
    stages:stages.map((stage:Json)=>({
      parallel:stage.parallel,failFast:stage.failFast,
      calls:(Array.isArray(stage.calls)?stage.calls:[]).map((call:Json)=>{
        const arg=call.input??{},c=arg.command??{};
        const compact:Json={};
        for(const name of ['description','path','paths','sourcePath','targetPath','destination',
          'action','mode','method','url','pattern','workspaceId','backgroundTaskId','stream']){
          if(arg[name]!==undefined)compact[name]=truncate(arg[name],250);
        }
        if(arg.command)compact.command={
          mode:c.mode,program:truncate(c.program,400),cwd:truncate(c.cwd,300),
          shellProfile:c.shellProfile,script:truncate(c.script,650),
          args:Array.isArray(c.args)?c.args.slice(0,12).map((v:unknown)=>truncate(v,180)):undefined,
        };
        return {id:call.id,tool:call.tool,input:compact};
      }),
    })),
  });
}

export function batchActivityResult(result:Json,regularPreview:string):string {
  if(regularPreview.length<=6000)return regularPreview;
  const stages=Array.isArray(result.stages)?result.stages:[];
  return JSON.stringify({
    completed:result.completed,failed:result.failed,skipped:result.skipped,
    stoppedEarly:result.stoppedEarly,durationMs:result.durationMs,previewLimited:true,
    stages:stages.map((stage:Json)=>({
      index:stage.index,parallel:stage.parallel,stoppedEarly:stage.stoppedEarly,
      results:(Array.isArray(stage.results)?stage.results:[]).map((call:Json)=>{
        const payload=call.result??{},data=(payload.data&&typeof payload.data==='object')?payload.data:payload;
        const limited:Json={};
        for(const key of ['exitCode','timedOut','cancelled','outputLimit','status','pid',
          'path','readBytes','writtenBytes','durationMs','stdoutTruncated','stderrTruncated']){
          if(data[key]!==undefined)limited[key]=data[key];
        }
        for(const key of ['stdout','stderr','outputPreview','content','errorSummary']){
          if(typeof data[key]==='string')limited[key]=truncate(data[key],key==='content'?300:550);
        }
        return {id:call.id,tool:call.tool,ok:call.ok,durationMs:call.durationMs,
          ...(call.error?{error:{code:call.error.code,message:truncate(call.error.message,400)}}:{}),
          ...(call.truncated?{truncated:true,resultBytes:call.resultBytes}:{}),
          ...(call.operationId?{operationId:call.operationId}:{}),
          result:{status:payload.status,data:limited}};
      }),
    })),
  });
}
