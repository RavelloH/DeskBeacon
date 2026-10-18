import { z } from 'zod';
const names = [
  'device_info','workspace_open','workspace_info','workspace_cd',
  'fs_list','fs_stat','fs_read','fs_read_many','fs_find','fs_grep',
  'fs_write','fs_edit','fs_manage','fs_archive',
  'exec_foreground','exec_background',
  'background_list','background_get','background_output','background_input','background_stop',
  'operation_get','operation_output','transfer_status','transfer_cancel',
  'net_ports','net_probe','http_request','system_snapshot','system_processes'
] as const;
/** Tools that return bounded structured results and do not include inline binary payloads. */
export const BATCH_TOOL_NAMES = names;
export type BatchToolName = typeof names[number];
/** Operations that are safe to dispatch concurrently on the same device. */
export const BATCH_PARALLEL_TOOLS:ReadonlySet<BatchToolName> = new Set([
  'device_info','workspace_info','fs_list','fs_stat','fs_read','fs_read_many',
  'fs_find','fs_grep','background_list','background_get','background_output',
  'operation_get','operation_output','transfer_status',
  'net_ports','net_probe','system_snapshot','system_processes'
]);
export const batchInputSchema=z.object({
  deviceId:z.string().trim().min(1).max(128),
  description:z.string().trim().min(1).max(120),
  stages:z.array(z.object({
    parallel:z.boolean().default(false),
    failFast:z.boolean().default(true),
    calls:z.array(z.object({
      id:z.string().min(1).max(64),
      tool:z.enum(names),
      input:z.record(z.string(),z.unknown()).default({})
    }).strict()).min(1).max(6)
  }).strict().refine(stage=>!stage.parallel||
    stage.calls.every(call=>BATCH_PARALLEL_TOOLS.has(call.tool)),
    'Parallel stages accept read-only tools only; use a serial stage for commands and mutations.')).min(1).max(6),
  maxResultBytes:z.number().int().min(1024).max(8192).default(4096)
}).strict().superRefine((data,ctx)=>{
  const calls=data.stages.flatMap(stage=>stage.calls);
  if(calls.length>16)ctx.addIssue({code:'custom',message:'Batch may contain at most 16 tool calls.',path:['stages']});
  const ids=new Set<string>();
  for(const [stageIndex,stage] of data.stages.entries()){
    for(const [index,call] of stage.calls.entries()){
      if(ids.has(call.id))ctx.addIssue({code:'custom',message:'Batch call IDs must be unique.',path:['stages',stageIndex,'calls',index,'id']});
      ids.add(call.id);
    }
  }
});
export type BatchInput=z.infer<typeof batchInputSchema>;
