export const UPDATE_PHASES=[
 '读取当前版本',
 '查询 npm 最新版本',
 '比较版本差异',
 '生成更新建议',
] as const;
export type UpdateStage=typeof UPDATE_PHASES[number];
export type UpdateKind='available'|'current'|'ahead';
export interface UpdateProgress{
 stage:UpdateStage; index:number; startedAt:number; currentVersion:string; latestVersion?:string;
}
export interface UpdateResult{currentVersion:string;latestVersion:string;kind:UpdateKind;commands:readonly string[];}
export const UPDATE_COMMANDS=['npm install -g deskbeacon@latest','npx deskbeacon@latest'] as const;
export function updateSummary(result:UpdateResult):string{
 if(result.kind==='available')return '发现新版本：'+result.currentVersion+' → '+result.latestVersion;
 if(result.kind==='ahead')return '当前版本 '+result.currentVersion+' 高于 npm latest（'+result.latestVersion+'），无需降级。';
 return '已是最新版本：'+result.currentVersion+'。';
}
function parseVersion(version:string){
 const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
 if(!match)throw Error('无法识别版本号：'+version);
 const identifiers=match[4]?.split('.')??[];
 if(identifiers.some(value=>!value||(/^\d+$/.test(value)&&value.length>1&&value.startsWith('0'))))
  throw Error('版本号预发布标记无效：'+version);
 return {numbers:match.slice(1,4).map(Number),pre:identifiers};
}
/** SemVer precedence including pre-release ordering; build metadata is ignored. */
export function compareVersions(left:string,right:string):number{
 const a=parseVersion(left),b=parseVersion(right);
 for(let i=0;i<3;i++)if(a.numbers[i]!==b.numbers[i])return a.numbers[i]! > b.numbers[i]! ? 1 : -1;
 if(!a.pre.length||!b.pre.length)return a.pre.length===b.pre.length?0:a.pre.length?-1:1;
 for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
  const aa=a.pre[i],bb=b.pre[i];
  if(aa===undefined||bb===undefined)return aa===undefined?-1:1;
  if(aa===bb)continue;
  const an=/^\d+$/.test(aa),bn=/^\d+$/.test(bb);
  if(an&&bn){
   const bigA=BigInt(aa),bigB=BigInt(bb);return bigA>bigB?1:-1;
  }
  if(an!==bn)return an?-1:1;
  return aa>bb?1:-1;
 }
 return 0;
}
export async function checkForUpdates(currentVersion:string,opts:{
 onProgress?:(progress:UpdateProgress)=>void;
 fetcher?:typeof fetch;
 signal?:AbortSignal;
 timeoutMs?:number;
}={}):Promise<UpdateResult>{
 const startedAt=Date.now();
 const report=(stage:UpdateStage,latestVersion?:string)=>{
  opts.onProgress?.({stage,index:UPDATE_PHASES.indexOf(stage),startedAt,currentVersion,...(latestVersion?{latestVersion}:{})});
 };
 report(UPDATE_PHASES[0]);
 parseVersion(currentVersion);
 opts.signal?.throwIfAborted();
 report(UPDATE_PHASES[1]);
 const controller=AbortSignal.any([opts.signal??new AbortController().signal,AbortSignal.timeout(opts.timeoutMs??8000)]);
 let response:Response;
 try{
  response=await (opts.fetcher??fetch)('https://registry.npmjs.org/deskbeacon/latest',{
   headers:{accept:'application/json'},signal:controller,cache:'no-store'
  });
 }catch(error){
  if(opts.signal?.aborted)throw Error('已取消更新检查');
  if(controller.aborted)throw Error('查询 npm 超时，请检查网络连接后重试');
  throw Error('无法连接 npm 注册表：'+(error instanceof Error?error.message:String(error)));
 }
 if(!response.ok){
  if(response.status===404)throw Error('npm 暂无 DeskBeacon 正式发布版本（HTTP 404）');
  throw Error('npm 版本查询失败：HTTP '+response.status);
 }
 let version:unknown;
 try{version=(await response.json() as {version?:unknown}).version;}
 catch{throw Error('npm 返回的版本信息不是有效的 JSON');}
 if(typeof version!=='string'||!version.trim())throw Error('npm 返回的版本信息缺少版本号');
 parseVersion(version);
 opts.signal?.throwIfAborted();
 report(UPDATE_PHASES[2],version);
 const comparison=compareVersions(currentVersion,version);
 const kind:UpdateKind=comparison<0?'available':comparison>0?'ahead':'current';
 report(UPDATE_PHASES[3],version);
 return{currentVersion,latestVersion:version,kind,commands:kind==='available'?UPDATE_COMMANDS:[]};
}
