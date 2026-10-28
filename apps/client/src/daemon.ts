import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { hostname, homedir, platform, arch, totalmem, freemem } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync,spawn } from 'node:child_process';
import { relative,sep } from 'node:path';
import {ripgrepExecutable} from './ripgrep.js';
import { WebSocket } from 'ws';
import {networkFetch,networkWebSocket} from './outbound-network.js';
import {availableShells,cpuCount} from './platform-compat.js';
import si from 'systeminformation';
import { createPreview, PROTOCOL_VERSION, LIMITS, ProtocolMessageSchema, toolInputSchemas, executeToolBatch, normalizeToolError, type ProtocolMessage, type BatchInput } from '@deskbeacon/protocol';
import { RecordJournal } from './record-journal.js';
import { TaskSupervisor } from './process.js';
import { batchActivityInput, batchActivityResult } from './batch-activity.js';
import { fileTool } from './filesystem.js';
import { systemTool, networkTool } from './system.js';
import {activityPage, type ActivityPageOptions} from './activity-query.js';
import {logEvent} from './diagnostics.js';
import {codeVersion} from './version.js';



export type Config={url:string;deviceId:string;accessToken:string;refreshToken?:string;accessTokenExpiresAt?:number;clientId:string;deviceName:string;pendingUrl?:string|undefined;proxyAuto?:boolean|undefined;proxyUrl?:string|null|undefined};
export const dataDir=process.env.DESKBEACON_DATA_DIR ?? join(homedir(),'.deskbeacon');
export const configPath=join(dataDir,'config.json');
/** Persist the two proxy settings with stable JSON types, including for legacy configs. */
export function saveConfig(config:Config){
 const stored={...config,proxyAuto:config.proxyAuto===true,
  proxyUrl:typeof config.proxyUrl==='string'&&config.proxyUrl.trim()?config.proxyUrl:null};
 mkdirSync(dataDir,{recursive:true});
 writeFileSync(configPath,JSON.stringify(stored,null,2),{mode:0o600});
 if(process.platform!=='win32')chmodSync(configPath,0o600);
}
export function loadConfig():Config{
 if(!existsSync(configPath))throw Error('DEVICE_NOT_CONFIGURED: run deskbeacon setup --url https://your-worker.example');
 const config=JSON.parse(readFileSync(configPath,'utf8')) as Config;
 return {...config,proxyAuto:config.proxyAuto===true,
  proxyUrl:typeof config.proxyUrl==='string'&&config.proxyUrl.trim()?config.proxyUrl:null};
}
const now=()=>new Date().toISOString();
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const err=(e:unknown)=>e instanceof Error?e.message:String(e);
function safeActorName(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const cleaned=value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim();
  return [...cleaned].slice(0,80).join('')||null;
}
export class ClientDaemon extends EventEmitter {
  private ws:WebSocket|null=null;
  private epoch=0;
  private ready=false;
  private state='disconnected';
  private renamePending=new Map<string,{resolve:(name:string)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  readonly db:DatabaseSync;
  readonly supervisor:TaskSupervisor;
  readonly journal:RecordJournal;
  private workspaces=new Map<string,{cwd:string;version:number;shellProfile:string}>();
  private stopped=false;
  private forceRefresh=false;
  private resultAckIds=new Map<string,string>();
  private replayInProgress=false;
  // Memory-only execution guard: a repeated dispatch with the same ID must never restart work.
  private operationInFlight=new Set<string>();
  private disconnectTimer:NodeJS.Timeout|undefined;
  private keepaliveTimer:NodeJS.Timeout|undefined;
  private handshakeTimer:NodeJS.Timeout|undefined;
  private reconnectTimer:NodeJS.Timeout|undefined;
  private connecting=false;
  // Retry fast only when disconnected. An established connection never polls for reconnection.
  private readonly reconnectDelayMs=1_000;
  private readonly startedAt=Date.now();
  private activityRevision=0;
  private heartbeatSentAt=0;
  private heartbeatAwaiting=false;
  private latencyMs:number|null=null;
  private lastHeartbeatAt:number|null=null;
  private heartbeatMisses=0;
  private socketOpenedAt=0;
  private heartbeatReplies=0;
  private cpuSample=process.cpuUsage();
  private cpuSampleAt=process.hrtime.bigint();
  private cpuPercent=0;
  private systemMemory={availableMemoryBytes:freemem(),totalMemoryBytes:totalmem()};
  private systemMemorySampleAt=0;
  private systemMemorySample:Promise<void>|undefined;
  private refreshSystemMemory(){
    if(Date.now()-this.systemMemorySampleAt>=1000){
      if(!this.systemMemorySample){
        this.systemMemorySample=si.mem().then(memory=>{
          if(Number.isFinite(memory.available)&&memory.available>=0&&Number.isFinite(memory.total)&&memory.total>0)
            this.systemMemory={availableMemoryBytes:memory.available,totalMemoryBytes:memory.total};
        }).catch(()=>{}).finally(()=>{
          this.systemMemorySampleAt=Date.now();this.systemMemorySample=undefined;
        });
      }
      // Windows systeminformation.mem() may take seconds on slow or cold hosts.
      // Never delay the IPC status response or the TUI refresh for this sample.
    }
    return this.systemMemory;
  }
  private async refreshAccessToken(){
    if(!this.config.refreshToken)return;
    if(!this.forceRefresh&&this.config.accessTokenExpiresAt&&Date.now()<this.config.accessTokenExpiresAt-60_000)return;
    const response=await networkFetch(this.config.url+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:this.config.refreshToken,client_id:this.config.clientId}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw Error("DEVICE_TOKEN_REFRESH_FAILED "+response.status);
    const token=await response.json() as {access_token:string;refresh_token?:string;expires_in?:number};
    this.config.accessToken=token.access_token;
    if(token.refresh_token)this.config.refreshToken=token.refresh_token;
    if(token.expires_in)this.config.accessTokenExpiresAt=Date.now()+token.expires_in*1000;
    this.forceRefresh=false;
    if(existsSync(configPath))try{const saved=loadConfig();if(saved.clientId===this.config.clientId)saveConfig({...saved,...this.config,pendingUrl:saved.pendingUrl,proxyAuto:saved.proxyAuto,proxyUrl:saved.proxyUrl});}catch{}
  }

  private transfers=new Map<string,{status:string;bytes:number;path:string}>();
  constructor(readonly config:Config) {
    super();
    mkdirSync(dataDir,{recursive:true});
    this.db=new DatabaseSync(join(dataDir,'state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL');
    // Connection diagnostics now live in logs/connection.jsonl, never SQLite.
    this.db.exec('DROP TABLE IF EXISTS connection_events');
    this.db.exec('CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, grant_id TEXT, tool TEXT, description TEXT, status TEXT, time INTEGER, result TEXT)');
    for(const column of ['request_json TEXT','finished_at INTEGER','duration_ms INTEGER','cwd TEXT','actor_name TEXT']){
      try{this.db.exec('ALTER TABLE activity ADD COLUMN '+column);}catch{}
    }
    for(const column of ['record_path TEXT','record_state TEXT','outcome TEXT','exit_code INTEGER','error_code TEXT','record_bytes INTEGER'])try{this.db.exec('ALTER TABLE activity ADD COLUMN '+column);}catch{}
    this.db.exec('CREATE INDEX IF NOT EXISTS activity_time_id_desc ON activity(time DESC,id DESC)');
    this.db.exec("CREATE INDEX IF NOT EXISTS activity_running_time_id_desc ON activity ((CASE WHEN status='running' THEN 1 ELSE 0 END) DESC,time DESC,id DESC)");
    // This Runtime owns its process tree. A prior Runtime's unfinished activity cannot still be running here.
    // Mark it interrupted (unknown result), not failed or successfully completed.
    this.db.prepare("UPDATE activity SET status='interrupted' WHERE status IN ('queued','running','accepted','started')").run();
    this.activityRevision=(this.db.prepare('SELECT COUNT(*) AS total FROM activity').get() as {total:number}).total;
    this.db.exec('CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, grant_id TEXT, cwd TEXT, shell TEXT, version INTEGER)');
    this.db.exec('CREATE TABLE IF NOT EXISTS unacked_results (operation_id TEXT PRIMARY KEY, tool TEXT NOT NULL, created INTEGER NOT NULL)');
    try{this.db.exec('ALTER TABLE unacked_results ADD COLUMN device_id TEXT');}catch{}
    this.db.prepare('DELETE FROM unacked_results WHERE device_id IS NULL OR device_id<>?').run(config.deviceId);
    this.journal=new RecordJournal(join(dataDir,'records'),(id,stream,size)=>this.emit('journal-output',{taskId:id,stream,size}));
    this.supervisor=new TaskSupervisor(this.db,join(dataDir,'output'),()=>this.emit('change'),this.journal);
    this.reconcileJournalReceipts();
  }
  /** Repair the crash window after JSONL fsync but before the SQLite receipt/ACK transaction. */
  private reconcileJournalReceipts():void{
    const rows=this.db.prepare("SELECT a.id,a.tool,a.record_path FROM activity a LEFT JOIN receipts r ON r.id=a.id "+
      "WHERE a.record_path IS NOT NULL AND (a.status IN ('interrupted','queued','running','accepted','started') OR r.status='accepted')")
      .all() as {id:string;tool:string;record_path:string}[];
    for(const row of rows){
      try{
        const journal=this.journal.getResult(row.record_path);
        if(!journal||!['completed','failed'].includes(journal.status))continue;
        const result=journal.result;
        const failure=journal.status==='failed'||Number(result?.exitCode??0)!==0||
          Boolean(result?.error||result?.spawnError||result?.timedOut||result?.isError)||
          Number(result?.failed??result?.failureCount??0)>0;
        this.db.exec('BEGIN IMMEDIATE');
        try{
          this.db.prepare('UPDATE activity SET status=?,outcome=?,exit_code=? WHERE id=?')
            .run(journal.status,failure?'failed':'success',Number.isSafeInteger(result?.exitCode)?result.exitCode:null,row.id);
          this.db.prepare('INSERT INTO receipts(id,status,created,result) VALUES(?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET status=excluded.status,result=NULL')
            .run(row.id,journal.status,Date.now());
          if(journal.status==='completed')
            this.db.prepare('INSERT OR IGNORE INTO unacked_results(operation_id,tool,created,device_id) VALUES(?,?,?,?)')
              .run(row.id,row.tool,Date.now(),this.config.deviceId);
          this.db.exec('COMMIT');
        }catch(e){this.db.exec('ROLLBACK');throw e;}
      }catch(e){logEvent('execution','receipt.reconciliation_failed','error',{operationId:row.id,error:e});}
    }
  }

  async status(includeBackground=true){
    const systemMemory=this.refreshSystemMemory();
    const current=process.cpuUsage(),clock=process.hrtime.bigint();
    const elapsedUs=Number(clock-this.cpuSampleAt)/1000;
    if(elapsedUs>=800_000){
      this.cpuPercent=Math.min(100,Math.max(0,100*((current.user-this.cpuSample.user)+(current.system-this.cpuSample.system))/elapsedUs));
      this.cpuSample=current;this.cpuSampleAt=clock;
    }
    const total=this.db.prepare('SELECT COUNT(*) AS total FROM activity').get() as {total:number};
    return {state:this.state,runtimeMode:process.env.DESKBEACON_RUNTIME_MODE??'legacy',deviceId:this.config.deviceId,deviceName:this.config.deviceName,
      server:this.config.url,uptimeMs:Date.now()-this.startedAt,memoryBytes:process.memoryUsage().rss,
      ...systemMemory,
      cpuPercent:Math.round(this.cpuPercent*10)/10,latencyMs:this.latencyMs,activityRevision:this.activityRevision,
      lastHeartbeatAt:this.lastHeartbeatAt,heartbeatMisses:this.heartbeatMisses,operationsTotal:total.total,
      active:this.supervisor.active().map(task=>{
        const row=this.db.prepare('SELECT actor_name,grant_id,request_json,cwd FROM activity WHERE id=?').get(task.id) as
          {actor_name:string|null;grant_id:string;request_json:string|null;cwd:string|null}|undefined;
        return {...task,...(row?{actorName:row.actor_name,grantId:row.grant_id,requestJson:row.request_json,cwd:row.cwd}:{})};
      }),...(includeBackground?{background:this.supervisor.list()}:{}),
      transfers:[...this.transfers].map(([id,t])=>({id,...t}))};
  }
  activityList(options:ActivityPageOptions={}){
    const page=activityPage(this.db,options);
    // UI hydration is demand-driven: no journal reads when a service has no TUI.
    for(const row of [...page.rows,...page.updates])if(typeof row.record_path==='string'&&row.record_path){
      try{
        const preview=this.journal.getPreview(row.record_path);
        if(row.tool==='batch'){
          const input=this.journal.getInput(row.record_path) as Record<string,any>|null;
          const output=this.journal.getResult(row.record_path)?.result as Record<string,any>|undefined;
          const fullInput=JSON.stringify(input??{}),fullOutput=JSON.stringify(output??{});
          row.request_json=batchActivityInput(input??{},fullInput);
          row.result=batchActivityResult(output??{},fullOutput);
        }else{
          row.request_json=preview.input;
          row.result=preview.result;
        }
      }catch{row.request_json=null;row.result=null;}
    }
    return page;
  }
  /** Slow full-text search is opt-in and runs in its own bounded process.
   * No background index, no service-wide text cache, no periodic filesystem scans. */
  async activitySearch(options:ActivityPageOptions={},signal?:AbortSignal){
    const query=(options.query??'').trim();
    if(!query||!existsSync(join(dataDir,'records')))return this.activityList(options);
    const root=join(dataDir,'records');
    const executable=await ripgrepExecutable();
    const paths=await new Promise<string[]>(resolve=>{
      let child:ReturnType<typeof spawn>;
      try{child=spawn(executable,['--files-with-matches','--fixed-strings','--ignore-case','--hidden',
        '--no-messages','--glob','*.jsonl','--',query,root],{windowsHide:true,stdio:['ignore','pipe','ignore']});}
      catch{return resolve([]);}
      let output='',bytes=0,done=false;
      const timer=setTimeout(()=>child.kill(),8000);timer.unref();
      const cancel=()=>child.kill();signal?.addEventListener('abort',cancel,{once:true});
      child.stdout?.on('data',(buf:Buffer)=>{
        bytes+=buf.byteLength;
        if(bytes>2*1024*1024){child.kill();return;}
        output+=buf.toString('utf8');
      });
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        resolve(output.split(/\r?\n/).filter(Boolean).slice(0,1000));};
      child.once('error',finish);child.once('close',finish);
    });
    const pathSet=new Set(paths.map(path=>relative(root,path).split(sep).join('/')).filter(p=>!p.startsWith('..')));
    const searchIds:string[]=[];
    for(const path of pathSet){
      const row=this.db.prepare('SELECT id FROM activity WHERE record_path=?').get(path) as {id:string}|undefined;
      if(row)searchIds.push(row.id);
    }
    return this.activityList({...options,searchIds});
  }
  private recordConnection(kind:string,detail=''){
    if(this.stopped)return;
    const level=/error|exception|failed/.test(kind)?'error':
      /timeout|closed|reconnect_scheduled|ack_deferred|disconnect/.test(kind)?'warn':
      /^(connecting|first_pong)$/.test(kind)?'debug':'info';
    logEvent('connection',kind,level,{detail,epoch:this.epoch,ready:this.ready,state:this.state,
      awaitingPong:this.heartbeatAwaiting,heartbeatMisses:this.heartbeatMisses,
      latencyMs:this.latencyMs,connectedForMs:this.socketOpenedAt?Date.now()-this.socketOpenedAt:null});
  }
  private persistDeviceName(name:string){
    if(this.config.deviceName===name)return;
    this.config.deviceName=name;
    if(existsSync(configPath)){
      const saved=loadConfig();
      if(saved.clientId===this.config.clientId)saveConfig({...saved,deviceName:name});
    }
    this.emit('change');
  }
  async rename(name:string):Promise<string>{
    const normalized=name.trim();
    if(!normalized||normalized.length>128||/[\u0000-\u001f\u007f]/u.test(normalized))
      throw Error('Device name must be 1-128 characters without control characters');
    if(!this.ready||this.ws?.readyState!==WebSocket.OPEN)throw Error('DEVICE_OFFLINE: start DeskBeacon and wait for a connected Runtime');
    const messageId=this.send({type:'device.rename',payload:{name:normalized}});
    return await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.renamePending.delete(messageId);reject(Error('DEVICE_RENAME_TIMEOUT'));},12_000);
      this.renamePending.set(messageId,{resolve,reject,timer});
    });
  }
  private cancelRenames(reason:string){
    for(const pending of this.renamePending.values()){
      clearTimeout(pending.timer);pending.reject(Error(reason));
    }
    this.renamePending.clear();
  }
  private scheduleReconnect(){
    if(this.stopped||this.reconnectTimer)return;
    const delay=this.reconnectDelayMs;
    this.recordConnection('reconnect_scheduled','delayMs='+delay);
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=undefined;
      void this.connect();
    },delay);
    this.reconnectTimer.unref();
  }
  async connect(){
    try{await this.connectOnce();}
    catch(error){
      this.connecting=false;
      if(this.stopped)return;
      this.recordConnection('connect_exception',err(error));
      this.state='error: '+err(error);
      logEvent('connection','connect.retryable_exception','error',{error});
      // A failed WebSocket constructor or local OS error is retryable, not a
      // fatal unhandled Promise rejection that kills the unattended service.
      const previous=this.ws;this.ws=null;
      if(previous){previous.on('error',()=>{});try{previous.terminate();}catch{}}
      this.emit('change');
      this.scheduleReconnect();
    }
  }
  private async connectOnce(){
    if(this.stopped||this.connecting||this.ws?.readyState===WebSocket.OPEN||this.ws?.readyState===WebSocket.CONNECTING)return;
    this.connecting=true;
    this.recordConnection('connecting');
    this.state='connecting';this.emit('change');
    try{await this.refreshAccessToken();}catch(e){
      this.connecting=false;
      this.state='error: '+err(e);this.emit('change');
      this.recordConnection('token_refresh_failed',err(e));
      logEvent('security','oauth.refresh_failed','error',{error:e});
      this.scheduleReconnect();
      return;
    }
    this.connecting=false;
    const target=this.config.url.replace(/^http:/,'ws:').replace(/^https:/,'wss:').replace(/\/$/,'')+'/device/connect';
    const socket=networkWebSocket(target,{headers:{Authorization:'Bearer '+this.config.accessToken}});
    this.ws=socket;this.ready=false;
    this.socketOpenedAt=Date.now();
    // A stalled TCP/TLS/WebSocket handshake must not leave the daemon stuck in connecting.
    this.handshakeTimer=setTimeout(()=>{
      if(this.ws===socket&&!this.ready){
        this.state='error: device handshake timeout';
        this.recordConnection('handshake_timeout','elapsedMs=10000');
        socket.terminate();
      }
    },10_000);
    this.handshakeTimer.unref();
    socket.on('open',()=>{
      this.socketOpenedAt=Date.now();
      this.heartbeatReplies=0;
      this.lastHeartbeatAt=null;
      this.heartbeatAwaiting=false;
      this.heartbeatMisses=0;
      this.recordConnection('websocket_open');
      this.state='connecting';this.emit('change');
      // Cloudflare DO replies using WebSocket auto-response without waking its handler.
      const heartbeat=()=>{
        if(socket.readyState!==WebSocket.OPEN||!this.ready)return;
        if(this.heartbeatAwaiting){
          this.heartbeatMisses++;
          if(this.heartbeatMisses>=3){
            this.recordConnection('heartbeat_timeout','misses='+this.heartbeatMisses);
            this.state='disconnected';socket.terminate();return;
          }
        }
        this.heartbeatSentAt=performance.now();
        this.heartbeatAwaiting=true;
        socket.send('ping');
      };
      // The observed upstream idle cutoff is ~19 seconds: one auto-response ping
      // every 10 seconds stays below it without frequent application-level traffic.
      this.keepaliveTimer=setInterval(heartbeat,10_000);
      this.keepaliveTimer.unref();
    });
    socket.on('message',raw=>{void this.message(raw.toString()).catch(e=>{logEvent('connection','message.handler_failed','error',{error:e});});});
    socket.on('close',(code,reason)=>{
      if(this.ws!==socket)return;
      if(this.handshakeTimer){clearTimeout(this.handshakeTimer);this.handshakeTimer=undefined;}
      if(this.keepaliveTimer){clearInterval(this.keepaliveTimer);this.keepaliveTimer=undefined;}
      const age=Date.now()-this.socketOpenedAt;
      const pongAge=this.lastHeartbeatAt===null?'never':String(Date.now()-this.lastHeartbeatAt)+'ms';
      this.recordConnection('websocket_closed','code='+code+' age='+age+'ms pongAge='+pongAge+' awaiting='+this.heartbeatAwaiting+' misses='+this.heartbeatMisses+' reason='+reason.toString());
      this.ready=false;this.state='disconnected';
      this.cancelRenames('DEVICE_DISCONNECTED');
      this.heartbeatAwaiting=false;this.latencyMs=null;this.emit('change');
      // shutdown() closes the socket asynchronously; never create a new 60s timer afterward.
      if(this.stopped)return;
      if(this.disconnectTimer)clearTimeout(this.disconnectTimer);
      this.disconnectTimer=setTimeout(()=>{
        if(this.ready||this.stopped)return;
        this.recordConnection('disconnect_grace_expired','foreground cancellation');
        for(const task of this.supervisor.active().filter(x=>x.kind==='foreground')){
          void this.supervisor.stop(task.id).catch(e=>logEvent('execution','foreground.stop_failed','error',{operationId:task.id,error:e}));
        }
      },LIMITS.shortDisconnectGraceMs);
      this.scheduleReconnect();
    });
    socket.on('unexpected-response',(_req,response)=>{if(response.statusCode===401)this.forceRefresh=true;});
    socket.on('error',e=>{
      this.recordConnection('websocket_error',err(e));
      this.state='error: '+err(e);
    });
  }
  /** Reloads network routing on the next connection attempt without restarting the service. */
  reconnectForProxyChange(){if(!this.stopped)this.ws?.terminate();}
  stop(){
    if(this.stopped)return;
    this.cancelRenames('DEVICE_STOPPED');
    this.stopped=true;
    if(this.disconnectTimer)clearTimeout(this.disconnectTimer);
    if(this.keepaliveTimer)clearInterval(this.keepaliveTimer);
    if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.ws?.close();this.journal.closeAll();this.db.close();
  }
  async shutdown(){
    if(this.stopped)return;
    this.cancelRenames('DEVICE_STOPPED');
    this.stopped=true;
    if(this.disconnectTimer)clearTimeout(this.disconnectTimer);
    if(this.keepaliveTimer)clearInterval(this.keepaliveTimer);
    if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    // Shutdown does not require a WebSocket close handshake. terminate() releases
    // the transport immediately rather than waiting up to 30 seconds.
    this.ws?.terminate();
    const ids=new Set(this.supervisor.active().map(task=>task.id.split(':')[0]!));
    await Promise.allSettled([...ids].map(id=>this.supervisor.stop(id)));
    const deadline=Date.now()+7500;
    while(this.supervisor.active().length&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,75));
    }
    // Background close listeners must finish SQLite updates before DB shutdown.
    this.journal.closeAll();this.db.close();
  }
  private send(value:Record<string,unknown>):string{
    if(this.ws?.readyState!==WebSocket.OPEN)throw Error('DEVICE_DISCONNECTED');
    const messageId=randomUUID();
    this.ws.send(JSON.stringify({version:PROTOCOL_VERSION,messageId,
      deviceId:this.config.deviceId,connectionEpoch:this.epoch,...value}));
    return messageId;
  }
  private async sendSafe(value:Record<string,unknown>):Promise<string>{
    while(this.ws?.readyState===WebSocket.OPEN&&this.ws.bufferedAmount>512*1024)await new Promise(r=>setTimeout(r,20));
    return this.send(value);
  }
  private restoredResult(id:string,receipt?:{status:string;result:string|null}):any|null{
    if(receipt?.result){try{return JSON.parse(receipt.result);}catch{}}
    const row=this.db.prepare('SELECT record_path FROM activity WHERE id=?').get(id) as {record_path:string|null}|undefined;
    if(!row?.record_path)return null;
    try{return this.journal.getResult(row.record_path)?.result??null;}catch{return null;}
  }
  private async replayPending(){
    if(this.replayInProgress||!this.ready)return;
    this.replayInProgress=true;
    try{
      // Replay *results*, not commands. Never dispatch another execution automatically.
      const items=this.db.prepare('SELECT operation_id,tool FROM unacked_results ORDER BY created ASC LIMIT 64').all() as {operation_id:string;tool:string}[];
      for(const item of items){
        if(!this.ready)break;
        const receipt=this.supervisor.hasReceipt(item.operation_id);
        if(receipt?.status!=='completed')continue;
        const result=this.restoredResult(item.operation_id,receipt);
        if(result===null)continue;
        try{await this.final(item.operation_id,item.tool,result);}
        catch(e){logEvent('execution','result.replay_suspended','error',{error:e});break;}
      }
    }finally{this.replayInProgress=false;}
  }
  private async message(raw:string){
    // Auto-response is an opaque text frame handled by the DO hibernation runtime.
    if(raw==='pong'){
      if(this.heartbeatAwaiting){
        this.latencyMs=Math.round(performance.now()-this.heartbeatSentAt);
        this.lastHeartbeatAt=Date.now();
        this.heartbeatAwaiting=false;this.heartbeatMisses=0;
        if(++this.heartbeatReplies===1)this.recordConnection('first_pong','rttMs='+this.latencyMs);
        this.emit('change');
      }
      return;
    }
    if(Buffer.byteLength(raw)>LIMITS.controlFrameBytes)return;
    const msg=ProtocolMessageSchema.safeParse(JSON.parse(raw));
    if(!msg.success)return;
    const m=msg.data;
    if(m.type==='device.ready'){
      this.epoch=m.connectionEpoch;this.ready=true;
      if(m.payload.deviceName)this.persistDeviceName(m.payload.deviceName);
      this.recordConnection('device_ready','epoch='+this.epoch);
      this.state='connected';this.emit('change');
      if(this.handshakeTimer){clearTimeout(this.handshakeTimer);this.handshakeTimer=undefined;}
      if(this.disconnectTimer){clearTimeout(this.disconnectTimer);this.disconnectTimer=undefined;}
      this.send({type:'device.hello',payload:{deviceName:this.config.deviceName,platform:platform(),clientVersion:codeVersion(),protocolVersion:PROTOCOL_VERSION}});
      this.send({type:'device.capabilities',payload:{capabilities:['filesystem','foreground','batch','background','archive','network','system','transfer-inline']}});
      if(this.ws?.readyState===WebSocket.OPEN){
        this.heartbeatSentAt=performance.now();
        this.heartbeatAwaiting=true;
        this.ws.send('ping');
      }
      void this.replayPending();
      return;
    }
    if(m.connectionEpoch!==this.epoch)return;
    if(m.type==='device.name.updated'){
      const pending=this.renamePending.get(m.payload.inReplyTo);
      if(pending){
        clearTimeout(pending.timer);
        this.renamePending.delete(m.payload.inReplyTo);
        this.persistDeviceName(m.payload.name);
        pending.resolve(m.payload.name);
      }
      return;
    }
    if(m.type==='control.ack'){
      const id=this.resultAckIds.get(m.payload.inReplyTo);
      if(id){this.resultAckIds.delete(m.payload.inReplyTo);this.db.prepare('DELETE FROM unacked_results WHERE operation_id=?').run(id);}
      return;
    }
    if(m.type==='operation.dispatch')await this.dispatch(m);
    else if(m.type==='foreground.cancel'){
      await this.supervisor.stop(m.operationId);
    }
  }
  private async dispatch(m:Extract<ProtocolMessage,{type:'operation.dispatch'}>){
    const opId=m.operationId,tool=m.toolName,input=m.input as Record<string,any>;
    const expected=sha(JSON.stringify([tool,input]));
    if(m.requestHash!==expected||Date.now()>Date.parse(m.expiresAt)){
      this.send({type:'operation.failed',operationId:opId,payload:{code:'INVALID_INPUT',message:'Request invalid, changed or expired',retryable:false}});
      return;
    }
    const actorName=safeActorName(m.actorName);
    if(actorName){
      const updated=this.db.prepare("UPDATE activity SET actor_name=? WHERE grant_id=? AND (actor_name IS NULL OR trim(actor_name)='' OR (actor_name='Agent' AND ?<>'Agent'))")
        .run(actorName,m.grantId,actorName);
      if(updated.changes){this.activityRevision++;this.emit('change');}
    }
    const prev=this.supervisor.hasReceipt(opId);
    if(prev){
      if(prev.status==='completed'){
        const replay=this.restoredResult(opId,prev);
        if(replay!==null)await this.final(opId,tool,replay);
        else this.send({type:'operation.failed',operationId:opId,payload:{code:'OPERATION_UNKNOWN',message:'Completed result is unavailable locally',retryable:false}});
      }
      else if(prev.status==='accepted'&&this.operationInFlight.has(opId)){
        // A reconnect may observe a locally queued (not yet started) command.
        this.send({type:'operation.accepted',operationId:opId,payload:{acceptedAt:now()}});
        const row=this.db.prepare('SELECT status FROM activity WHERE id=?').get(opId) as {status:string}|undefined;
        if(row?.status==='running')this.send({type:'operation.started',operationId:opId,payload:{startedAt:now()}});
      }else this.send({type:'operation.failed',operationId:opId,payload:{code:'OPERATION_UNKNOWN',message:'A previous execution is no longer live; check its result before retrying',retryable:false}});
      return;
    }
    let journalPath:string;
    try{journalPath=this.journal.start(opId,tool,input,{isBackground:tool==='exec_background'});}
    catch(e){this.send({type:'operation.failed',operationId:opId,payload:{code:'LOCAL_STORAGE_ERROR',message:'Unable to persist operation journal',retryable:false}});return;}
    this.supervisor.record(opId,'accepted',{});
    this.operationInFlight.add(opId);
    const description=String(input.description??tool);
    // Input is retained once by RecordJournal; SQLite stores only metadata.
    const started=Date.now();
    const fileAction=['fs_read','fs_write','fs_edit'].includes(tool);
    const pathHint=input.path??input.sourcePath??input.targetPath;
    const cwd=String(input.command?.cwd??input.cwd??
      (fileAction&&typeof pathHint==='string'?dirname(pathHint):pathHint)??process.cwd());
    this.db.prepare('INSERT OR REPLACE INTO activity(id,grant_id,actor_name,tool,description,status,time,cwd,request_json,record_path,record_state,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(opId,m.grantId,actorName,tool,description,tool==='exec_foreground'?'queued':'running',started,cwd,null,journalPath,'ready','running');
    this.activityRevision++;
    this.emit('change');
    // Acceptance is already persisted locally. A disconnect during the ACK
    // must not silently prevent an otherwise valid, once-only execution.
    try{this.send({type:'operation.accepted',operationId:opId,payload:{acceptedAt:now()}});}
    catch{this.recordConnection('operation_ack_deferred','accepted '+opId);}
    if(tool!=='exec_foreground'){
      try{this.send({type:'operation.started',operationId:opId,payload:{startedAt:now()}});}
      catch{this.recordConnection('operation_ack_deferred','started '+opId);}
    }
    try{
      const result=await this.execute(tool,input,opId,m.grantId);
      this.journal.finish(opId,result,'completed',{background:tool==='exec_background'});
      this.supervisor.record(opId,'completed',result);
      const failure=result&&typeof result==='object'&&(Number(result.exitCode??0)!==0||result.isError===true||Boolean(result.error||result.spawnError||result.timedOut)||Number(result.failureCount??result.failed??0)>0);
      this.db.prepare('UPDATE activity SET status=?,result=NULL,finished_at=?,duration_ms=?,outcome=?,exit_code=?,error_code=? WHERE id=?')
        .run('completed',Date.now(),Date.now()-started,failure?'failed':'success',Number.isSafeInteger(result?.exitCode)?result.exitCode:null,typeof result?.code==='string'?result.code:null,opId);
      this.activityRevision++;
      this.emit('change');
      this.db.prepare('INSERT OR IGNORE INTO unacked_results(operation_id,tool,created,device_id) VALUES(?,?,?,?)').run(opId,tool,Date.now(),this.config.deviceId);
      try{await this.final(opId,tool,result);}
      catch(e){logEvent('execution','result.awaiting_retry','warn',{operationId:opId,error:e});}
    }catch(e){
      const error=normalizeToolError(e),message=error.message;
      try{this.journal.finish(opId,{error:message,code:error.code,...(error.partialResult?{partialResult:error.partialResult}:{})},'failed');}catch{}
      this.supervisor.record(opId,'failed',{error:message,code:error.code});
      this.db.prepare('UPDATE activity SET status=?,result=NULL,finished_at=?,duration_ms=?,outcome=?,error_code=? WHERE id=?')
        .run('failed',Date.now(),Date.now()-started,'failed',error.code,opId);
      this.activityRevision++;
      this.emit('change');
      if(this.ws?.readyState===WebSocket.OPEN){
        this.send({type:'operation.failed',operationId:opId,payload:{...error}});
      }
    }finally{this.operationInFlight.delete(opId);this.supervisor.clearCancelled(opId);}
  }
  private async final(id:string,tool:string,result:any){
    if(tool==='exec_foreground'){
      const stdout=String(result.stdout??''),stderr=String(result.stderr??'');
      const stdoutBytes=Buffer.byteLength(stdout),stderrBytes=Buffer.byteLength(stderr);
      if(stdoutBytes+stderrBytes>LIMITS.operationOutputBytes){
        this.send({type:'operation.failed',operationId:id,payload:{code:'OUTPUT_LIMIT',message:'Foreground text exceeds DO history budget',retryable:false}});return;
      }
      this.send({type:'operation.result.begin',operationId:id,payload:{stdoutBytes,stderrBytes}});
      for(const [stream,text] of [['stdout',stdout],['stderr',stderr]] as const){
        let index=0;
        for(let pos=0;pos<text.length;pos+=8192){
          await this.sendSafe({type:'operation.result.chunk',operationId:id,payload:{stream,chunkIndex:index++,text:text.slice(pos,pos+8192)}});
        }
      }
      const meta=JSON.parse(JSON.stringify(result,(k,v)=>(k==="stdout"||k==="stderr")?undefined:v));
      const messageId=await this.sendSafe({type:'operation.result.commit',operationId:id,payload:{result:meta,committedAt:now()}});
      this.resultAckIds.set(messageId,id);
    }else{
      const frame={type:"operation.result.commit",operationId:id,payload:{result,committedAt:now()}};
      if(Buffer.byteLength(JSON.stringify(frame))>LIMITS.controlFrameBytes-1024){
        this.send({type:"operation.failed",operationId:id,payload:{code:"OUTPUT_LIMIT",message:"Result exceeds MCP transport frame; reduce requested size/quality",retryable:false}});return;
      }
      const messageId=await this.sendSafe(frame);
      this.resultAckIds.set(messageId,id);
    }
  }
  private async execute(tool:string,input:Record<string,any>,operationId:string,grantId:string):Promise<any>{
    if(tool==='batch'){
      const batch=input as BatchInput;
      this.supervisor.trackBatch(operationId,true);
      try{
        return await executeToolBatch(batch,async(name,subInput,callId)=>{
          const parsed=toolInputSchemas[name].safeParse(subInput);
          if(!parsed.success)return {isError:true,code:'INVALID_INPUT',message:parsed.error.message.slice(0,1500)};
          if(name==='operation_get'||name==='operation_output')
            return {isError:true,code:'UNSUPPORTED_TOOL',message:'Use DO history tools outside a device-local batch'};
          // A sub-operation has a stable local identity, but no separate DO operation.
          const localId=operationId+':'+callId;
          const childRef=this.journal.start(localId,name,parsed.data,{parentOperationId:operationId,isBackground:name==='exec_background'});
          this.journal.linkChild(operationId,localId,childRef,name);
          let result:any;
          try{
            result=await this.execute(name,parsed.data as Record<string,any>,localId,grantId);
            this.journal.finish(localId,result,'completed',{background:name==='exec_background'});
          }catch(error){
            try{this.journal.finish(localId,{error:err(error)},'failed');}catch{}
            throw error;
          }
          if(name==='exec_foreground'){
            const {stdout,stderr,...metadata}=result;
            const budget=Math.min(batch.maxResultBytes,8192);
            const out=String(stdout??''),err=String(stderr??'');
            const preview=Math.max(128,Math.floor((budget-1024)/2));
            const outPreview=createPreview(out,preview),errPreview=createPreview(err,preview);
            return {status:'completed',childOperationId:localId,
              data:{...metadata,stdout:outPreview.text,stderr:errPreview.text,
                stdoutTruncated:outPreview.truncated,stderrTruncated:errPreview.truncated,
                stdoutPreviewMeta:outPreview,stderrPreviewMeta:errPreview,
                stdoutBytes:outPreview.originalBytes,stderrBytes:errPreview.originalBytes}};
          }
          return {status:'completed',childOperationId:localId,data:result};
        },()=>this.supervisor.isCancelled(operationId));
      }finally{this.supervisor.trackBatch(operationId,false);}
    }
    if(tool==='batch_output'){
      const parent=this.db.prepare('SELECT grant_id,record_path FROM activity WHERE id=? AND tool=?')
        .get(input.parentOperationId,'batch') as {grant_id:string;record_path:string|null}|undefined;
      if(!parent||parent.grant_id!==grantId||!parent.record_path)throw Error('OPERATION_UNKNOWN');
      const childId=input.parentOperationId+':'+input.callId;
      const child=this.journal.getChildren(parent.record_path).find(item=>item.id===childId);
      if(!child)throw Error('OPERATION_UNKNOWN: batch call not found');
      const page=this.journal.getRecordStream(child.path,input.stream,input.byteOffset,input.maxBytes);
      return {parentOperationId:input.parentOperationId,childOperationId:childId,callId:input.callId,...page};
    }
    if(tool==='device_info')return{deviceId:this.config.deviceId,name:this.config.deviceName,platform:platform(),
      architecture:arch(),hostname:hostname(),cpuCount:cpuCount(),freeMemoryBytes:freemem(),
      totalMemoryBytes:totalmem(),defaultCwd:process.cwd(),nodeVersion:process.version,
      availableShells:availableShells(),defaultShell:process.platform==='win32'?(availableShells().includes('pwsh.exe')?'pwsh':'powershell'):process.platform==='darwin'?'zsh':'bash'};
    if(tool==='workspace_open'){
      const id=input.workspaceId??randomUUID(),cwd=resolve(input.path);
      const existing=this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as any;
      if(existing){
        if(existing.grant_id!==grantId)throw Error('WORKSPACE_FORBIDDEN');
        return {workspaceId:id,cwd:existing.cwd,shellProfile:existing.shell,version:existing.version,reused:true};
      }
      await fs.stat(cwd).then(s=>{if(!s.isDirectory())throw Error('NOT_A_DIRECTORY');});
      this.db.prepare('INSERT INTO workspaces(id,grant_id,cwd,shell,version) VALUES(?,?,?,?,?)')
        .run(id,grantId,cwd,input.shellProfile??(platform()==='win32'?(availableShells().includes('pwsh.exe')?'pwsh':'powershell'):platform()==='darwin'?'zsh':'bash'),0);
      return{workspaceId:id,cwd,version:0};
    }
    if(tool==='workspace_info'||tool==='workspace_cd'){
      const row=this.db.prepare('SELECT * FROM workspaces WHERE id=? AND grant_id=?').get(input.workspaceId,grantId) as any;
      if(!row)throw Error('WORKSPACE_NOT_FOUND');
      if(tool==='workspace_cd'){
        if(input.expectedVersion!==undefined&&input.expectedVersion!==row.version)throw Error('WORKSPACE_VERSION_CONFLICT');
        const cwd=resolve(row.cwd,input.path);await fs.stat(cwd).then(s=>{if(!s.isDirectory())throw Error('NOT_A_DIRECTORY');});
        this.db.prepare('UPDATE workspaces SET cwd=?,version=version+1 WHERE id=?').run(cwd,input.workspaceId);
        return{workspaceId:input.workspaceId,cwd,version:row.version+1};
      }
      return{workspaceId:row.id,cwd:row.cwd,shellProfile:row.shell,version:row.version};
    }
    // Command schemas nest workspaceId under command; file tools keep it top-level.
    // Reading only input.workspaceId silently ran commands in the daemon default cwd.
    const id=(tool==='exec_foreground'||tool==='exec_background'
      ?input.command?.workspaceId:input.workspaceId) as string|undefined;
    let workspace:string|undefined,profile:string|undefined;
    if(id){
      const row=this.db.prepare('SELECT * FROM workspaces WHERE id=? AND grant_id=?').get(id,grantId) as any;
      if(!row)throw Error('WORKSPACE_NOT_FOUND');
      workspace=row.cwd;profile=row.shell;
    }
    if(tool.startsWith('fs_'))return fileTool(tool,input,workspace,
      tool==='fs_edit'?diff=>this.journal.stream(operationId,'diff',Buffer.from(diff,'utf8')):undefined);
    if(tool==='exec_foreground'){
      const command={...input.command,cwd:input.command.cwd??workspace??process.cwd(),shellProfile:input.command.shellProfile??profile};
      return await this.supervisor.foreground(operationId,input.description,command,input.timeoutMs??input.command.timeoutMs??LIMITS.defaultForegroundTimeoutMs,
        operationId.includes(':')?undefined:()=>{
          this.db.prepare("UPDATE activity SET status='running' WHERE id=?").run(operationId);
          this.activityRevision++;this.emit('change');
          try{this.send({type:'operation.started',operationId,payload:{startedAt:now()}});}
          catch{this.recordConnection('operation_ack_deferred','started '+operationId);}
        });
    }
    if(tool==='exec_background'){
      const cmd={...input.command,cwd:input.command.cwd??workspace??process.cwd(),shellProfile:input.command.shellProfile??profile};
      return await this.supervisor.startBackground(operationId,input.description,cmd);
    }
    if(tool==='background_list')return{tasks:this.supervisor.list()};
    if(tool==='background_get'){
      const item=this.supervisor.get(input.backgroundTaskId) as Record<string,any>|null;
      return{task:item?{...item,backgroundTaskId:item.id,operationId:item.operation_id,
        exitCode:item.exit_code,startedAt:new Date(item.start).toISOString(),
        stdoutPath:item.stdout_path,stderrPath:item.stderr_path,
        recordPath:item.record_path}:null};
    }
    if(tool==='background_stop')return this.supervisor.stop(input.backgroundTaskId);
    if(tool==='background_input')return this.supervisor.input(input.backgroundTaskId,input.data,input.signal);
    if(tool==='background_output'){
      const output=this.supervisor.output(input.backgroundTaskId,input.stream,Number(input.cursor??0),input.maxBytes,input.maxLines);
      return {...output,
        ...(input.stream==='both'?{nextOffsets:{
          stdout:output.results[0]?.nextOffset??0,stderr:output.results[1]?.nextOffset??0
        }}:{nextCursor:String(output.results[0]?.nextOffset??0)})};
    }
    if(tool==='net_ports')return systemTool(tool,input);
    if(tool.startsWith('net_')||tool==='http_request')return networkTool(tool,input);
    if(tool.startsWith('system_')||tool==='screen_capture')return systemTool(tool,input);
    if(tool==='transfer_upload'){
      if(!input.dataBase64)throw Error('UNSUPPORTED_HOST_TRANSFER: inline data required');
      const bytes=Buffer.from(input.dataBase64,'base64');
      if(bytes.length>LIMITS.transferInlineBytes)throw Error('TRANSFER_LIMIT: use supported streaming Host');
      if(input.expectedBytes!==undefined&&input.expectedBytes!==bytes.length)throw Error('TRANSFER_INCOMPLETE');
      if(input.sha256&&createHash("sha256").update(bytes).digest("hex")!==input.sha256)throw Error("TRANSFER_HASH_MISMATCH");
      const target=resolve(input.targetPath);
      await fs.mkdir(resolve(target,'..'),{recursive:true});
      await fs.writeFile(target,bytes,{flag:input.overwrite?'w':'wx'});
      const transferId=randomUUID();
      this.transfers.set(transferId,{status:'completed',bytes:bytes.length,path:target});
      return{transferId,status:'completed',writtenBytes:bytes.length,path:target};
    }
    if(tool==='transfer_download'){
      const source=resolve(input.sourcePath);
      const stat=await fs.stat(source),offset=Math.min(input.offset??0,stat.size);
      const length=Math.min(stat.size-offset,input.maxBytes??LIMITS.transferInlineBytes,LIMITS.transferInlineBytes);
      const handle=await fs.open(source,'r');
      const bytes=Buffer.alloc(length);
      try{await handle.read(bytes,0,length,offset);}finally{await handle.close();}
      const transferId=randomUUID();
      this.transfers.set(transferId,{status:'completed',bytes:bytes.length,path:input.sourcePath});
      return{transferId,status:'completed',bytes:bytes.length,totalBytes:stat.size,
        offset,nextOffset:offset+bytes.length,hasMore:offset+bytes.length<stat.size,
        dataBase64:bytes.toString('base64'),
        sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    if(tool==='transfer_status')return{transferId:input.transferId,...this.transfers.get(input.transferId)};
    if(tool==='transfer_cancel')return{transferId:input.transferId,cancelled:false,reason:'no active streaming transfers'};
    throw Error('UNSUPPORTED_TOOL: '+tool);
  }
}
