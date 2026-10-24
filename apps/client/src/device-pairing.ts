import {createHash,randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {networkFetch} from './outbound-network.js';
import {logEvent} from './diagnostics.js';
import {validateSetupUrl,registerSetupClient,exchangeSetupCode,saveSetupCredentials,type SetupProgress} from './setup-flow.js';

export const DEVICE_SETUP_PHASES=[
 '校验服务器地址','注册 OAuth 客户端','获取设备配对码',
 '等待其他设备确认','交换访问令牌','保存设备配置',
] as const;
type PairStart={device_code:string;user_code:string;verification_uri:string;expires_in:number;interval:number};
const raw64=(value:Buffer)=>value.toString('base64url');
function sleep(ms:number,signal?:AbortSignal){
 return new Promise<void>((resolve,reject)=>{
  if(signal?.aborted){reject(Error('用户取消了设备授权'));return;}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('用户取消了设备授权'));};
  signal?.addEventListener('abort',abort,{once:true});
 });
}
export async function runDeviceSetupFlow(rawUrl:string,options:{
 onProgress?:(progress:SetupProgress)=>void;signal?:AbortSignal;timeoutMs?:number;
}={}):Promise<{deviceId:string;server:string}>{
 const startedAt=Date.now();let server='';
 const notify=(index:number,details:Partial<SetupProgress>={})=>
  options.onProgress?.({stage:DEVICE_SETUP_PHASES[index]!,index,startedAt,server,mode:'device',...details});
 try{
  options.signal?.throwIfAborted();
  notify(0);server=validateSetupUrl(rawUrl);
  const verifier=raw64(randomBytes(32)),challenge=raw64(createHash('sha256').update(verifier).digest());
  notify(1);
  const redirect=server+'/pair/callback';
  const clientId=await registerSetupClient(server,redirect,options.signal);
  notify(2);
  const init=await networkFetch(server+'/pair/start',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({client_id:clientId,code_challenge:challenge,device_name:hostname()}),
   signal:AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(15000)])});
  if(!init.ok)throw Error('获取配对码失败：HTTP '+init.status);
  const pair=await init.json() as PairStart;
  const destination=new URL(pair.verification_uri);
  if(destination.origin!==server||destination.pathname!=='/activate'||
   !/^[A-Za-z0-9_-]{43}$/.test(pair.device_code??'')||
   !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(pair.user_code??'')||
   !Number.isFinite(pair.expires_in)||pair.expires_in<=0||pair.expires_in>900||
   !Number.isFinite(pair.interval)||pair.interval<3||pair.interval>60)
   throw Error('服务器返回的配对参数无效');
  const end=Date.now()+Math.min(pair.expires_in*1000,options.timeoutMs??300_000);
  let intervalMs=Math.max(3000,Math.min((pair.interval||5)*1000,30000));
  notify(3,{userCode:pair.user_code,verificationUri:pair.verification_uri});
  let code:string|undefined;
  while(Date.now()<end){
   options.signal?.throwIfAborted();
   const response=await networkFetch(server+'/pair/poll',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({device_code:pair.device_code}),
    signal:AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(15000)])});
   const result=await response.json().catch(()=>({})) as {status?:string;code?:string;error?:string;interval?:number};
   if(response.status===202&&result.status==='pending'){
    intervalMs=Math.max(intervalMs,Math.min(Math.max(3,Number.isFinite(result.interval)?result.interval!:5)*1000,30_000));
   }else if(response.status===429||result.error==='slow_down'){
    intervalMs+=5000;
   }else if(response.ok&&result.status==='authorized'&&typeof result.code==='string'){
    code=result.code;break;
   }else if(result.status==='denied')throw Error('用户拒绝了设备授权');
   else if(result.error==='expired_token'||response.status===410)throw Error('设备配对码已过期');
   else throw Error('设备配对状态异常：HTTP '+response.status);
   await sleep(Math.min(intervalMs,Math.max(0,end-Date.now())),options.signal);
  }
  if(!code)throw Error('等待设备授权超时，请重新运行 setup');
  notify(4);
  const credentials=await exchangeSetupCode(server,clientId,redirect,code,verifier,options.signal);
  notify(5);
  saveSetupCredentials(server,clientId,credentials,options.signal);
  return {deviceId:clientId,server};
 }catch(error){
  logEvent('security','oauth.device_pairing_failed','error',{error,server});
  if(options.signal?.aborted)throw Error('用户取消了设备授权');
  throw error;
 }
}
