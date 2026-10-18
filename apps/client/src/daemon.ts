import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { hostname, homedir, platform, arch, totalmem, freemem, cpus } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, LIMITS, ProtocolMessageSchema, type ProtocolMessage } from '@deskbeacon/protocol';
import { TaskSupervisor } from './process.js';
import { fileTool } from './filesystem.js';
import { systemTool, networkTool } from './system.js';

export type Config={url:string;deviceId:string;accessToken:string;refreshToken?:string;accessTokenExpiresAt?:number;clientId:string;deviceName:string};
export const dataDir=process.env.DESKBEACON_DATA_DIR ?? join(homedir(),'.deskbeacon');
export const configPath=join(dataDir,'config.json');
export function saveConfig(config:Config){mkdirSync(dataDir,{recursive:true});writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});if(process.platform!=='win32')chmodSync(configPath,0o600);}
export function loadConfig():Config{if(!existsSync(configPath))throw Error('DEVICE_NOT_CONFIGURED: run deskbeacon setup --url https://your-worker.example');return JSON.parse(readFileSync(configPath,'utf8')) as Config;}
const now=()=>new Date().toISOString();
function availableShells(){
 const names=process.platform==='win32'?['pwsh.exe','powershell.exe','cmd.exe','bash.exe','wsl.exe']:
  ['bash','zsh','sh','pwsh'];
 const cmd=process.platform==='win32'?'where.exe':'which';
 return names.filter(name=>spawnSync(cmd,[name],{windowsHide:true,timeout:2000}).status===0);
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const err=(e:unknown)=>e instanceof Error?e.message:String(e);
export class ClientDaemon extends EventEmitter {
  private ws:WebSocket|null=null;
  private epoch=0;
  private ready=false;
  private state='disconnected';
  readonly db:DatabaseSync;
  readonly supervisor:TaskSupervisor;
  private workspaces=new Map<string,{cwd:string;version:number;shellProfile:string}>();
  private stopped=false;
  private forceRefresh=false;
  private resultAckIds=new Map<string,string>();
  private replayInProgress=false;
  private disconnectTimer:NodeJS.Timeout|undefined;
  private keepaliveTimer:NodeJS.Timeout|undefined;
  private handshakeTimer:NodeJS.Timeout|undefined;
  private reconnectTimer:NodeJS.Timeout|undefined;
  private connecting=false;
  private reconnectDelayMs=1500;
  private readonly startedAt=Date.now();
  private heartbeatSentAt=0;
  private heartbeatAwaiting=false;
  private latencyMs:number|null=null;
  private lastHeartbeatAt:number|null=null;
  private heartbeatMisses=0;
  private cpuSample=process.cpuUsage();
  private cpuSampleAt=process.hrtime.bigint();
  private cpuPercent=0;
  private async refreshAccessToken(){
    if(!this.config.refreshToken)return;
    if(!this.forceRefresh&&this.config.accessTokenExpiresAt&&Date.now()<this.config.accessTokenExpiresAt-60_000)return;
    const response=await fetch(this.config.url+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:this.config.refreshToken,client_id:this.config.clientId}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw Error("DEVICE_TOKEN_REFRESH_FAILED "+response.status);
    const token=await response.json() as {access_token:string;refresh_token?:string;expires_in?:number};
    this.config.accessToken=token.access_token;
    if(token.refresh_token)this.config.refreshToken=token.refresh_token;
    if(token.expires_in)this.config.accessTokenExpiresAt=Date.now()+token.expires_in*1000;
    this.forceRefresh=false;
    if(existsSync(configPath))try{const saved=loadConfig();if(saved.clientId===this.config.clientId)saveConfig(this.config);}catch{}
  }

  private transfers=new Map<string,{status:string;bytes:number;path:string}>();
  constructor(readonly config:Config) {
    super();
    mkdirSync(dataDir,{recursive:true});
    this.db=new DatabaseSync(join(dataDir,'state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, grant_id TEXT, tool TEXT, description TEXT, status TEXT, time INTEGER, result TEXT)');
    for(const column of ['request_json TEXT','finished_at INTEGER','duration_ms INTEGER','cwd TEXT','actor_name TEXT']){
      try{this.db.exec('ALTER TABLE activity ADD COLUMN '+column);}catch{}
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, grant_id TEXT, cwd TEXT, shell TEXT, version INTEGER)');
    this.db.exec('CREATE TABLE IF NOT EXISTS unacked_results (operation_id TEXT PRIMARY KEY, tool TEXT NOT NULL, created INTEGER NOT NULL)');
    try{this.db.exec('ALTER TABLE unacked_results ADD COLUMN device_id TEXT');}catch{}
    this.db.prepare('DELETE FROM unacked_results WHERE device_id IS NULL OR device_id<>?').run(config.deviceId);
    this.supervisor=new TaskSupervisor(this.db,join(dataDir,'output'));
  }
  status(){
    const current=process.cpuUsage(),clock=process.hrtime.bigint();
    const elapsedUs=Number(clock-this.cpuSampleAt)/1000;
    if(elapsedUs>=800_000){
      this.cpuPercent=Math.min(100,Math.max(0,100*((current.user-this.cpuSample.user)+(current.system-this.cpuSample.system))/elapsedUs));
      this.cpuSample=current;this.cpuSampleAt=clock;
    }
    const total=this.db.prepare('SELECT COUNT(*) AS total FROM activity').get() as {total:number};
    return {state:this.state,runtimeMode:process.env.DESKBEACON_RUNTIME_MODE??'legacy',deviceId:this.config.deviceId,deviceName:this.config.deviceName,
      server:this.config.url,uptimeMs:Date.now()-this.startedAt,memoryBytes:process.memoryUsage().rss,
      cpuPercent:Math.round(this.cpuPercent*10)/10,latencyMs:this.latencyMs,
      lastHeartbeatAt:this.lastHeartbeatAt,heartbeatMisses:this.heartbeatMisses,operationsTotal:total.total,
      active:this.supervisor.active(),background:this.supervisor.list(),
      transfers:[...this.transfers].map(([id,t])=>({id,...t})),
      activity:this.db.prepare('SELECT id,grant_id,actor_name,tool,description,status,time,finished_at,duration_ms,cwd,request_json,result FROM activity ORDER BY time DESC LIMIT 40').all()};
  }
  private scheduleReconnect(){
    if(this.stopped||this.reconnectTimer)return;
    const delay=this.reconnectDelayMs;
    this.reconnectDelayMs=Math.min(this.reconnectDelayMs*2,30_000);
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=undefined;
      void this.connect();
    },delay);
    this.reconnectTimer.unref();
  }
  async connect(){
    if(this.stopped||this.connecting||this.ws?.readyState===WebSocket.OPEN)return;
    this.connecting=true;
    this.state='connecting';this.emit('change');
    try{await this.refreshAccessToken();}catch(e){
      this.connecting=false;
      this.state='error: '+err(e);this.emit('change');
      console.error('DeskBeacon token refresh:',err(e));
      this.scheduleReconnect();
      return;
    }
    this.connecting=false;
    const target=this.config.url.replace(/^http:/,'ws:').replace(/^https:/,'wss:').replace(/\/$/,'')+'/device/connect';
    const socket=new WebSocket(target,{headers:{Authorization:'Bearer '+this.config.accessToken}});
    this.ws=socket;this.ready=false;
    // A stalled TCP/TLS/WebSocket handshake must not leave the daemon stuck in connecting.
    this.handshakeTimer=setTimeout(()=>{
      if(this.ws===socket&&!this.ready){
        this.state='error: device handshake timeout';
        socket.terminate();
      }
    },15_000);
    this.handshakeTimer.unref();
    socket.on('open',()=>{
      this.state='connected';this.emit('change');
      // Cloudflare DO replies using WebSocket auto-response without waking its handler.
      const heartbeat=()=>{
        if(socket.readyState!==WebSocket.OPEN||!this.ready)return;
        if(this.heartbeatAwaiting){
          this.heartbeatMisses++;
          if(this.heartbeatMisses>=3){
            this.state='disconnected';socket.terminate();return;
          }
        }
        this.heartbeatSentAt=performance.now();
        this.heartbeatAwaiting=true;
        socket.send('ping');
      };
      this.keepaliveTimer=setInterval(heartbeat,60_000);
      this.keepaliveTimer.unref();
    });
    socket.on('message',raw=>{void this.message(raw.toString()).catch(e=>{console.error('Remote message:',err(e));});});
    socket.on('close',(code,reason)=>{
      if(this.ws!==socket)return;
      if(this.handshakeTimer){clearTimeout(this.handshakeTimer);this.handshakeTimer=undefined;}
      if(this.keepaliveTimer){clearInterval(this.keepaliveTimer);this.keepaliveTimer=undefined;}
      console.error('DeskBeacon WebSocket closed:',code,reason.toString());this.ready=false;this.state='disconnected';
      this.heartbeatAwaiting=false;this.latencyMs=null;this.emit('change');
      if(this.disconnectTimer)clearTimeout(this.disconnectTimer);
      this.disconnectTimer=setTimeout(()=>{
        if(this.ready||this.stopped)return;
        for(const task of this.supervisor.active().filter(x=>x.kind==='foreground')){
          void this.supervisor.stop(task.id).catch(e=>console.error('Disconnected foreground stop:',err(e)));
        }
      },LIMITS.shortDisconnectGraceMs);
      this.scheduleReconnect();
    });
    socket.on('unexpected-response',(_req,response)=>{if(response.statusCode===401)this.forceRefresh=true;});
    socket.on('error',e=>{this.state='error: '+err(e);console.error('DeskBeacon WebSocket:',err(e));});
  }
  stop(){
    if(this.stopped)return;
    this.stopped=true;
    if(this.disconnectTimer)clearTimeout(this.disconnectTimer);
    if(this.keepaliveTimer)clearInterval(this.keepaliveTimer);
    if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.ws?.close();this.db.close();
  }
  async shutdown(){
    if(this.stopped)return;
    this.stopped=true;
    if(this.disconnectTimer)clearTimeout(this.disconnectTimer);
    if(this.keepaliveTimer)clearInterval(this.keepaliveTimer);
    if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.ws?.close();
    const ids=new Set(this.supervisor.active().map(task=>task.id.split(':')[0]!));
    await Promise.allSettled([...ids].map(id=>this.supervisor.stop(id)));
    const deadline=Date.now()+7500;
    while(this.supervisor.active().length&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,75));
    }
    // Background close listeners must finish SQLite updates before DB shutdown.
    this.db.close();
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
  private async replayPending(){
    if(this.replayInProgress||!this.ready)return;
    this.replayInProgress=true;
    try{
      // Replay *results*, not commands. Never dispatch another execution automatically.
      const items=this.db.prepare('SELECT operation_id,tool FROM unacked_results ORDER BY created ASC LIMIT 64').all() as {operation_id:string;tool:string}[];
      for(const item of items){
        if(!this.ready)break;
        const receipt=this.supervisor.hasReceipt(item.operation_id);
        if(receipt?.status!=='completed'||!receipt.result)continue;
        try{await this.final(item.operation_id,item.tool,JSON.parse(receipt.result));}
        catch(e){console.error('Result replay suspended:',err(e));break;}
      }
    }finally{this.replayInProgress=false;}
  }
  private async message(raw:string){
    // Auto-response is an opaque text frame handled by the DO hibernation runtime.
    if(raw==='pong'){
      if(this.heartbeatAwaiting){
        this.latencyMs=Math.round(performance.now()-this.heartbeatSentAt);
        this.lastHeartbeatAt=Date.now();
        this.heartbeatAwaiting=false;this.heartbeatMisses=0;this.emit('change');
      }
      return;
    }
    if(Buffer.byteLength(raw)>LIMITS.controlFrameBytes)return;
    const msg=ProtocolMessageSchema.safeParse(JSON.parse(raw));
    if(!msg.success)return;
    const m=msg.data;
    if(m.type==='device.ready'){
      this.epoch=m.connectionEpoch;this.ready=true;
      this.state='connected';this.emit('change');
      this.reconnectDelayMs=1500;
      if(this.handshakeTimer){clearTimeout(this.handshakeTimer);this.handshakeTimer=undefined;}
      if(this.disconnectTimer){clearTimeout(this.disconnectTimer);this.disconnectTimer=undefined;}
      this.send({type:'device.hello',payload:{deviceName:this.config.deviceName,platform:platform(),clientVersion:'0.1.0',protocolVersion:PROTOCOL_VERSION}});
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
    const prev=this.supervisor.hasReceipt(opId);
    if(prev){
      if(prev.status==='completed'&&prev.result)await this.final(opId,tool,JSON.parse(prev.result));
      else this.send({type:'operation.failed',operationId:opId,payload:{code:'OPERATION_UNKNOWN',message:'Operation was already accepted and may still be running',retryable:false}});
      return;
    }
    this.supervisor.record(opId,'accepted',{});
    const description=String(input.description??tool);
    const privateKey=/token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key/i;
    const redact=(key:string,value:any)=>{
      if(['content','dataBase64','env'].includes(key)||privateKey.test(key))return '[redacted]';
      if(typeof value==='string'&&value.length>4000)return value.slice(0,4000)+' [truncated]';
      if(Array.isArray(value)&&value.length>80)return [...value.slice(0,80),'[truncated]'];
      return value;
    };
    const safeInput=JSON.parse(JSON.stringify(input,redact));
    const started=Date.now();
    const fileAction=['fs_read','fs_write','fs_edit'].includes(tool);
    const pathHint=input.path??input.sourcePath??input.targetPath;
    const cwd=String(input.command?.cwd??input.cwd??
      (fileAction&&typeof pathHint==='string'?dirname(pathHint):pathHint)??process.cwd());
    const requestPreview=JSON.stringify(safeInput);
    this.db.prepare('INSERT OR REPLACE INTO activity(id,grant_id,actor_name,tool,description,status,time,cwd,request_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(opId,m.grantId,m.actorName??null,tool,description,'running',started,cwd,
        requestPreview.length>6000?JSON.stringify({summary:'参数过大，详情已省略'}):requestPreview);
    this.emit('change');
    this.send({type:'operation.accepted',operationId:opId,payload:{acceptedAt:now()}});
    this.send({type:'operation.started',operationId:opId,payload:{startedAt:now()}});
    try{
      const result=await this.execute(tool,input,opId,m.grantId);
      this.supervisor.record(opId,'completed',result);
      const safeResult=JSON.stringify(result,(key,value)=>{
        if(['content','dataBase64','env'].includes(key)||privateKey.test(key))return '[redacted]';
        if(typeof value==='string'&&value.length>3000)return value.slice(0,3000)+' [truncated]';
        if(Array.isArray(value)&&value.length>40)return [...value.slice(0,40),'[truncated]'];
        return value;
      });
      const resultPreview=safeResult.length>6000?JSON.stringify({summary:'结果过大，请查看操作日志'}):safeResult;
      this.db.prepare('UPDATE activity SET status=?,result=?,finished_at=?,duration_ms=? WHERE id=?')
        .run('completed',resultPreview,Date.now(),Date.now()-started,opId);
      this.emit('change');
      this.db.prepare('INSERT OR IGNORE INTO unacked_results(operation_id,tool,created,device_id) VALUES(?,?,?,?)').run(opId,tool,Date.now(),this.config.deviceId);
      try{await this.final(opId,tool,result);}
      catch(e){console.error('Completed operation result awaiting retry:',err(e));}
    }catch(e){
      const message=err(e);
      this.supervisor.record(opId,'failed',{error:message});
      this.db.prepare('UPDATE activity SET status=?,result=?,finished_at=?,duration_ms=? WHERE id=?')
        .run('failed',JSON.stringify({error:message}).slice(0,32000),Date.now(),Date.now()-started,opId);
      this.emit('change');
      if(this.ws?.readyState===WebSocket.OPEN){
        this.send({type:'operation.failed',operationId:opId,payload:{code:message.split(':')[0]?.slice(0,64)||'INTERNAL',message:message.slice(0,2000),retryable:false}});
      }
    }
  }
  private async final(id:string,tool:string,result:any){
    if(tool==='exec_foreground'||tool==='exec_batch'){
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
    if(tool==='device_info')return{deviceId:this.config.deviceId,name:this.config.deviceName,platform:platform(),
      architecture:arch(),hostname:hostname(),cpuCount:cpus().length,freeMemoryBytes:freemem(),
      totalMemoryBytes:totalmem(),defaultCwd:process.cwd(),nodeVersion:process.version,
      availableShells:availableShells(),defaultShell:process.platform==='win32'?(availableShells().includes('pwsh.exe')?'pwsh':'powershell'):process.platform==='darwin'?'zsh':'bash'};
    if(tool==='workspace_open'){
      const id=randomUUID(),cwd=resolve(input.path);
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
    const id=input.workspaceId as string|undefined;
    let workspace:string|undefined,profile:string|undefined;
    if(id){
      const row=this.db.prepare('SELECT * FROM workspaces WHERE id=? AND grant_id=?').get(id,grantId) as any;
      if(!row)throw Error('WORKSPACE_NOT_FOUND');
      workspace=row.cwd;profile=row.shell;
    }
    if(tool.startsWith('fs_'))return fileTool(tool,input,workspace);
    if(tool==='exec_foreground'){
      const command={...input.command,cwd:input.command.cwd??workspace??process.cwd(),shellProfile:input.command.shellProfile??profile};
      return await this.supervisor.foreground(operationId,input.description,command,input.timeoutMs);
    }
    if(tool==='exec_batch'){
      const stages=input.stages.map((s:any)=>({...s,commands:s.commands.map((c:any)=>({
        ...c,cwd:c.cwd??input.cwd??workspace??process.cwd(),shellProfile:c.shellProfile??profile
      }))}));
      return await this.supervisor.batch(operationId,input.description,stages,input.timeoutMs);
    }
    if(tool==='exec_background'){
      const cmd={...input.command,cwd:input.command.cwd??workspace??process.cwd(),shellProfile:input.command.shellProfile??profile};
      return await this.supervisor.startBackground(operationId,input.description,cmd);
    }
    if(tool==='background_list')return{tasks:this.supervisor.list()};
    if(tool==='background_get')return{task:this.supervisor.get(input.backgroundTaskId)};
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
      const bytes=await fs.readFile(resolve(input.sourcePath));
      if(bytes.length>Math.min(input.maxBytes??LIMITS.transferInlineBytes,LIMITS.transferInlineBytes))
        throw Error('UNSUPPORTED_HOST_TRANSFER: requires streaming byte endpoint');
      const transferId=randomUUID();
      this.transfers.set(transferId,{status:'completed',bytes:bytes.length,path:input.sourcePath});
      return{transferId,status:'completed',bytes:bytes.length,dataBase64:bytes.toString('base64'),
        sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    if(tool==='transfer_status')return{transferId:input.transferId,...this.transfers.get(input.transferId)};
    if(tool==='transfer_cancel')return{transferId:input.transferId,cancelled:false,reason:'no active streaming transfers'};
    throw Error('UNSUPPORTED_TOOL: '+tool);
  }
}
