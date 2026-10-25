import { DurableObject } from "cloudflare:workers";
import { createPreview,previewFromEdges,LIMITS, PROTOCOL_VERSION, ProtocolMessageSchema, type ProtocolMessage } from "@deskbeacon/protocol";
import type { Env, DeviceRecord } from "./env.js";

type Waiter = {
  resolve:(value:Record<string,unknown>)=>void;
  subscribers:Set<(value:Record<string,unknown>)=>void>;
  timer:ReturnType<typeof setTimeout>;
  deadline:number; extraMs:number; suspendedAt?:number; expire:()=>void;
  disconnectTimer?:ReturnType<typeof setTimeout>;
};
type Rpc = { name: string; input: Record<string, unknown>; grantId: string; actorName?: string; operationId: string };
type Row = Record<string, any>;
const FG = new Set(["exec_foreground"]);
const HISTORY = new Set(["operation_get", "operation_output"]);

function failure(code: string, message: string, operationId?: string, partialResult?:unknown): Record<string, unknown> {
  return { isError: true, code, message, ...(operationId ? { operationId } : {}),
    ...(partialResult!==undefined?{partialResult}:{}) };
}
function json(value: unknown, status=200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
function utf8size(value: string) { return new TextEncoder().encode(value).byteLength; }

export class DeviceSession extends DurableObject<Env> {
  private waiters = new Map<string, Waiter>();
  // Foreground admission and scheduling are owned by the device runtime.
  // These exist only while a synchronous MCP request is alive. No polling or alarms.
  private socketWaiters=new Set<(socket:WebSocket)=>void>();
  private pendingDispatches=new Map<string,{send:(socket:WebSocket)=>void;attempts:number}>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ops(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, idem TEXT UNIQUE, result TEXT, stdout_bytes INTEGER DEFAULT 0, stderr_bytes INTEGER DEFAULT 0)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chunks(op_id TEXT NOT NULL, stream TEXT NOT NULL, idx INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(op_id,stream,idx))");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS ops_expires ON ops(expires)");
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN request_hash TEXT");}catch{}
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN dispatch_attempts INTEGER DEFAULT 0");}catch{}
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN accepted_at INTEGER");}catch{}
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN started_at INTEGER");}catch{}
    // Legacy fg_queue tables may exist on upgraded DOs, but are no longer used.
    // The client is the sole owner of admission, queuing and execution slots.
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN history_evicted INTEGER DEFAULT 0");}catch{}
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"));
  }

  private currentSocket(): WebSocket | null {
    // A previous epoch may still briefly report OPEN while being replaced.
    const epoch=this.epoch();
    return this.ctx.getWebSockets().find(ws =>
      ws.readyState===WebSocket.OPEN &&
      (ws.deserializeAttachment() as {epoch?:number}|null)?.epoch===epoch)??null;
  }
  private epoch(): number {
    return Number((this.ctx.storage.sql.exec("SELECT value FROM state WHERE key='epoch'").toArray()[0] as Row | undefined)?.value ?? 0);
  }
  /** Suspend a live RPC while disconnected; wake only on a real connection event or timeout. */
  private async waitForSocket(maxWaitMs:number):Promise<WebSocket|null>{
    const existing=this.currentSocket();
    if(existing||maxWaitMs<=0)return existing;
    // Bound outstanding requests held during an outage, including non-foreground tools.
    if(this.socketWaiters.size>=32)return null;
    return await new Promise<WebSocket|null>(resolve=>{
      let timer:ReturnType<typeof setTimeout>;
      const ready=(socket:WebSocket)=>{clearTimeout(timer);this.socketWaiters.delete(ready);resolve(socket);};
      timer=setTimeout(()=>{this.socketWaiters.delete(ready);resolve(null);},maxWaitMs);
      this.socketWaiters.add(ready);
      // Check again to close the race with a reconnect between the first read and registration.
      const raced=this.currentSocket();
      if(raced)ready(raced);
    });
  }
  private lookup(id: string): Row | undefined {
    return this.ctx.storage.sql.exec("SELECT * FROM ops WHERE id=?", id).toArray()[0] as Row | undefined;
  }
  private saveStatus(id:string, status:string, data:unknown=null) {
    this.ctx.storage.sql.exec("UPDATE ops SET status=?,result=? WHERE id=?", status, data === null ? null : JSON.stringify(data), id);
  }

  private historySize():number {
    const stored=this.ctx.storage.sql.exec("SELECT value FROM state WHERE key='historyBytes'").toArray()[0] as Row|undefined;
    if(stored)return Number(stored.value);
    const sum=Number((this.ctx.storage.sql.exec("SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM chunks").one() as Row).bytes);
    this.setHistorySize(sum);return sum;
  }
  private setHistorySize(value:number) {
    this.ctx.storage.sql.exec("INSERT INTO state(key,value) VALUES('historyBytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(value));
  }
  private ensureHistoryCapacity(incomingBytes:number, currentOp:string):boolean {
    let size=this.historySize();
    while(size+incomingBytes>LIMITS.deviceHistoryBytes){
      const victim=this.ctx.storage.sql.exec(
        "SELECT o.id AS id, COALESCE(SUM(length(CAST(c.content AS BLOB))),0) AS bytes FROM chunks c JOIN ops o ON o.id=c.op_id WHERE o.status='completed' AND o.id<>? GROUP BY o.id ORDER BY MIN(o.created) ASC LIMIT 1",currentOp).toArray()[0] as Row|undefined;
      if(!victim)return false;
      this.ctx.storage.sql.exec("DELETE FROM chunks WHERE op_id=?",victim.id);
      this.ctx.storage.sql.exec("UPDATE ops SET history_evicted=1 WHERE id=?",victim.id);
      size=Math.max(0,size-Number(victim.bytes));
      this.setHistorySize(size);
    }
    return true;
  }
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if(pathname==="/security/consume"){
      if(request.method!=="POST")return json({error:"method_not_allowed"},405);
      const value=await request.json().catch(()=>null) as {id?:unknown;expires?:unknown}|null;
      if(!value||typeof value.id!=="string"||!(/^(?:challenge:[a-f0-9]{64}|proof:[a-f0-9-]{36})$/.test(value.id))||
         typeof value.expires!=="number"||!Number.isSafeInteger(value.expires)||
         value.expires<=Date.now()||value.expires>Date.now()+600_000)
        return json({consumed:false},400);
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cap_used (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)");
      this.ctx.storage.sql.exec("DELETE FROM cap_used WHERE expires<=?",Date.now());
      const old=this.ctx.storage.sql.exec("SELECT id FROM cap_used WHERE id=?",value.id).toArray();
      if(old.length)return json({consumed:false},409);
      this.ctx.storage.sql.exec("INSERT INTO cap_used(id,expires) VALUES(?,?)",value.id,value.expires);
      return json({consumed:true});
    }
    if(pathname==="/revoke"){
      if(request.method!=="POST")return json({error:"method_not_allowed"},405);
      for(const ws of this.ctx.getWebSockets())if(ws.readyState===WebSocket.OPEN)ws.close(4003,"device authorization revoked");
      return json({revoked:true});
    }
    if (pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(failure("INVALID_INPUT","Expected WebSocket upgrade"),426);
      const deviceId = request.headers.get("x-device-id");
      if (!deviceId || deviceId.length > 128) return json(failure("INVALID_INPUT","Missing authenticated device ID"),400);
      const record = await this.env.OAUTH_KV.get("device:" + deviceId,"json") as DeviceRecord | null;
      const pair = new WebSocketPair();
      const client=pair[0]!;
      const server=pair[1]!;
      const next = this.epoch() + 1;
      for(const waiter of this.waiters.values()){
        if(waiter.disconnectTimer){clearTimeout(waiter.disconnectTimer);delete waiter.disconnectTimer;}
        if(waiter.suspendedAt!==undefined){
          const elapsed=Date.now()-waiter.suspendedAt;
          const extension=Math.min(elapsed,Math.max(0,LIMITS.shortDisconnectGraceMs-waiter.extraMs));
          waiter.extraMs+=extension;waiter.deadline+=extension;
          delete waiter.suspendedAt;
          clearTimeout(waiter.timer);
          waiter.timer=setTimeout(waiter.expire,Math.max(1,waiter.deadline-Date.now()));
        }
      }
      for(const old of this.ctx.getWebSockets()) if(old.readyState===WebSocket.OPEN) old.close(4001,"reconnected");
      this.ctx.storage.sql.exec("INSERT INTO state(key,value) VALUES('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(next));
      server.serializeAttachment({ epoch:next, deviceId });
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ version:PROTOCOL_VERSION, type:"device.ready", messageId:crypto.randomUUID(),
        deviceId:"self", connectionEpoch:next, payload:{ready:true,...(record?.label?{deviceName:record.label}:{})} }));
      // Reconnection itself is the only retry trigger; no background polling or Alarm.
      for(const notify of [...this.socketWaiters])notify(server);
      for(const [id,pending] of this.pendingDispatches){
        if(this.lookup(id)?.status!=="dispatched"){this.pendingDispatches.delete(id);continue;}
        if(pending.attempts>=3)continue;
        pending.attempts++;
        try{pending.send(server);}catch{/* Wait for another connection or the RPC deadline. */}
      }
      return new Response(null, {status:101,webSocket:client});
    }
    if(pathname==="/rpc") {
      if(request.method!=="POST") return json(failure("INVALID_INPUT","POST required"),405);
      const body = await request.json().catch(()=>null) as Rpc|null;
      if(!body || typeof body.name!=="string" || typeof body.operationId!=="string" ||
        typeof body.grantId!=="string" || !body.input || typeof body.input!=="object")
        return json(failure("INVALID_INPUT","Invalid RPC message"),400);
      if(HISTORY.has(body.name)) return json(this.readHistory(body));
      // The DO forwards independent Agent calls immediately. The client owns the
      // sole FIFO queue and its four command slots, including commands in batches.
      return json(await this.dispatch(body));
    }
    if(pathname==="/status") return json({ online:!!this.currentSocket(),epoch:this.epoch() });
    return new Response("Not found",{status:404});
  }

  private readHistory(body: Rpc): Record<string,unknown> {
    const opId=String(body.input.operationId??"");
    const row=this.lookup(opId);
    if(!row || row.grant_id!==body.grantId) return failure("OPERATION_UNKNOWN","Operation not found or expired",opId);
    if(body.name==="operation_get")
      return { operationId:opId,status:row.status,tool:row.tool,createdAt:row.created,
        dispatchAttempts:Number(row.dispatch_attempts??0),acceptedAt:row.accepted_at??null,startedAt:row.started_at??null,
        historyEvicted:Boolean(row.history_evicted),
        stdoutBytes:row.stdout_bytes,stderrBytes:row.stderr_bytes,
        result:row.result?JSON.parse(row.result):null };
    if(row.history_evicted)return failure("HISTORY_EVICTED","Foreground text history was evicted to honor the per-device storage budget",opId);
    const maxBytes=Math.min(1_048_576,Math.max(1,Number(body.input.maxBytes??65_536)));
    const maxLines=Math.max(1,Number(body.input.maxLines??10_000));
    const stream=String(body.input.stream??"both");
    const skipLines=Number(body.input.lineOffset??0);
    const offset=Number(body.input.byteOffset??0);
    const needle=String(body.input.literalContains??"");
    const rows=this.ctx.storage.sql.exec("SELECT stream,idx,content FROM chunks WHERE op_id=? ORDER BY stream,idx",opId).toArray() as Row[];
    let source=rows.filter(r=>stream==="both"||r.stream===stream).map(r=>String(r.content??"")).join("");
    if(needle)source=source.split(/(?<=\n)/).filter(line=>line.includes(needle)).join("");
    if(skipLines>0)source=source.split(/(?<=\n)/).slice(skipLines).join("");
    const bytes=new TextEncoder().encode(source);
    if(offset>=bytes.byteLength)return {operationId:opId,output:"",nextCursor:String(bytes.byteLength),
      hasMore:false,complete:row.status==="completed",returnedBytes:0};
    // Never let an arbitrarily long single line stall pagination. Preserve UTF-8 boundaries.
    let endOffset=Math.min(bytes.byteLength,offset+maxBytes);
    if(endOffset<bytes.byteLength)while(endOffset>offset && (bytes[endOffset]!&0xc0)===0x80)endOffset--;
    if(endOffset===offset)endOffset=Math.min(bytes.byteLength,offset+4);
    const decoded=new TextDecoder().decode(bytes.subarray(offset,endOffset));
    const lines=decoded.split(/(?<=\n)/);
    const page=lines.slice(0,maxLines).join("");
    const used=new TextEncoder().encode(page).byteLength;
    const nextOffset=offset+used;
    return {operationId:opId,output:page,nextCursor:String(nextOffset),
      hasMore:nextOffset<bytes.byteLength,complete:row.status==="completed",stream,returnedBytes:used};
  }

  private async dispatch(body:Rpc):Promise<Record<string,unknown>> {
    const isFg=FG.has(body.name);
    const canCancel=isFg||body.name==='batch';
    const input=body.input;
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([body.name,input])));
    const requestHash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
    const existingKey=typeof body.input.idempotencyKey==="string" ? body.grantId+":"+body.input.idempotencyKey : null;
    if(existingKey) {
      const prev=this.ctx.storage.sql.exec("SELECT id,status,result,request_hash FROM ops WHERE idem=?",existingKey).toArray()[0] as Row|undefined;
      if(prev && prev.request_hash!==requestHash) return failure("DUPLICATE_OPERATION","Idempotency key already used with different tool parameters",prev.id);
      if(prev){
        if(prev.result && ["completed","failed","cancelled"].includes(prev.status))
          return {operationId:prev.id,...JSON.parse(prev.result)};
        const waiter=this.waiters.get(prev.id);
        if(waiter){
          // Rejoin the same in-flight operation; never dispatch the command again.
          return await new Promise<Record<string,unknown>>(resolve=>waiter.subscribers.add(resolve));
        }
        return failure("OPERATION_UNKNOWN","Idempotent operation has no live waiter; inspect operation history before retry",prev.id);
      }
    }
    if(!this.currentSocket()&&!await this.waitForSocket(LIMITS.shortDisconnectGraceMs))
      return failure("DEVICE_OFFLINE","Device did not reconnect within the 60s dispatch window; command was not sent",body.operationId);
    const opId=body.operationId;
    const timeout=Math.min(LIMITS.maxForegroundTimeoutMs,Math.max(1000,Number(body.input.timeoutMs??((body.input.command as Record<string,unknown>|undefined)?.timeoutMs)??(body.name==='batch'?LIMITS.maxForegroundTimeoutMs:isFg?LIMITS.defaultForegroundTimeoutMs:30_000))));
    const totalWaitMs=timeout+(canCancel?LIMITS.localQueueWaitMs:0);
    // The device must also accept a delivery postponed by the bounded outage allowance.
    const expires=Date.now()+totalWaitMs+LIMITS.shortDisconnectGraceMs+10_000;
    this.ctx.storage.sql.exec("INSERT INTO ops(id,grant_id,tool,status,created,expires,idem,request_hash) VALUES(?,?,?,?,?,?,?,?)",
      opId,body.grantId,body.name,"dispatched",Date.now(),Date.now()+LIMITS.operationTtlMs,existingKey,requestHash);
    const socket=this.currentSocket();
    if(!socket) {this.saveStatus(opId,"unknown");return failure("DEVICE_OFFLINE","Device disconnected",opId);}
    const epoch=(socket.deserializeAttachment() as {epoch?:number}|null)?.epoch??this.epoch();
    const response=new Promise<Record<string,unknown>>(resolve=>{
      const deadline=Date.now()+totalWaitMs+5_000;
      const expire=()=>{
        const expired=this.waiters.get(opId);
        if(!expired)return;
        this.waiters.delete(opId);
        if(expired.disconnectTimer)clearTimeout(expired.disconnectTimer);
        this.ctx.storage.sql.exec("UPDATE ops SET status='unknown' WHERE id=? AND status NOT IN ('completed','failed')",opId);
        const cancelSocket=this.currentSocket();
        if(canCancel && cancelSocket){
          try{cancelSocket.send(JSON.stringify({
            version:PROTOCOL_VERSION,type:"foreground.cancel",messageId:crypto.randomUUID(),
            deviceId:"self",connectionEpoch:this.epoch(),operationId:opId,payload:{reason:"server timeout"}
          }));}catch{}
        }
        const value=failure("OPERATION_TIMEOUT","Operation deadline exceeded; execution state may be unknown",opId);
        for(const subscriber of expired?.subscribers??[])subscriber(value);
        resolve(value);
      };
      const timer=setTimeout(expire,totalWaitMs+5_000);
      this.waiters.set(opId,{resolve,timer,subscribers:new Set(),deadline,extraMs:0,expire});
    });
    // Until the device acknowledges receipt, the frame may have been dropped by a
    // half-open WebSocket. Re-send the SAME operation ID; the device persists a
    // receipt before doing work and only acknowledges duplicates, never re-executes.
    const sendDispatch=(target:WebSocket)=>{
      const targetEpoch=(target.deserializeAttachment() as {epoch?:number}|null)?.epoch??this.epoch();
      target.send(JSON.stringify({version:PROTOCOL_VERSION,type:"operation.dispatch",messageId:crypto.randomUUID(),
        deviceId:"self",connectionEpoch:targetEpoch,operationId:opId,grantId:body.grantId,
        ...(typeof body.actorName==="string"?{actorName:body.actorName.slice(0,80)}:{}),
        expiresAt:new Date(expires).toISOString(),requestHash,toolName:body.name,input}));
      this.ctx.storage.sql.exec("UPDATE ops SET dispatch_attempts=dispatch_attempts+1 WHERE id=?",opId);
    };
    // Bound total delivery attempts (initial + up to two reconnects).
    // Until a reconnect or result, no timer runs and no Alarm is scheduled.
    const pending={send:sendDispatch,attempts:1};
    this.pendingDispatches.set(opId,pending);
    try{sendDispatch(socket);}catch{/* Only a connection event may trigger another attempt. */}
    try{return await response;}finally{this.pendingDispatches.delete(opId);}
  }

  private finish(id:string,result:Record<string,unknown>,status:string) {
    this.pendingDispatches.delete(id);
    const row=this.lookup(id);
    if(!row) return;
    const fg=FG.has(row.tool);
    // Never persist transfer file contents, screenshots, or other binary-bearing tool data.
    const persist=fg ? result : (status==="completed"?{status:"completed"}:result);
    this.saveStatus(id,status,persist);
    const waiter=this.waiters.get(id);
    if(waiter){
      clearTimeout(waiter.timer);
      if(waiter.disconnectTimer)clearTimeout(waiter.disconnectTimer);
      this.waiters.delete(id);
      const value={operationId:id,...result};
      waiter.resolve(value);
      for(const subscriber of waiter.subscribers)subscriber(value);
    }
    void this.scheduleRetention();
  }

  private async scheduleRetention() {
    const current=await this.ctx.storage.getAlarm();
    if(current===null) await this.ctx.storage.setAlarm(Date.now()+LIMITS.operationTtlMs);
  }
  async alarm() {
    const now=Date.now();
    const expired=this.ctx.storage.sql.exec("SELECT id FROM ops WHERE expires<?",now).toArray() as Row[];
    for(const {id} of expired) this.ctx.storage.sql.exec("DELETE FROM chunks WHERE op_id=?",id);
    this.ctx.storage.sql.exec("DELETE FROM ops WHERE expires<?",now);
    const kept=Number((this.ctx.storage.sql.exec("SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS n FROM chunks").one() as Row).n);
    this.setHistorySize(kept);
    if((this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM ops").one() as Row).n>0)
      await this.ctx.storage.setAlarm(now+LIMITS.operationTtlMs);
  }

  async webSocketMessage(ws:WebSocket, raw:string|ArrayBuffer) {
    const attachment=ws.deserializeAttachment() as {epoch:number;deviceId?:string}|null;
    if(!attachment || attachment.epoch!==this.epoch()) {ws.close(4001,"stale device connection");return;}
    // File bytes are NEVER persisted; unsupported binary data must not be echoed into text tables.
    if(typeof raw!=="string") return;
    if(utf8size(raw)>LIMITS.controlFrameBytes) {ws.close(1009,"frame too large");return;}
    let msg:ProtocolMessage;
    try {msg=ProtocolMessageSchema.parse(JSON.parse(raw));} catch{return;}
    if(msg.connectionEpoch!==attachment.epoch) return;
    if(msg.deviceId!==attachment.deviceId){ws.close(1008,"device ID mismatch");return;}
    if(msg.type==="device.hello") return;
    if(msg.type==="device.rename"){
      const name=msg.payload.name.trim();
      const key="device:"+attachment.deviceId;
      const existing=await this.env.OAUTH_KV.get(key,"json") as DeviceRecord|null;
      if(!existing){ws.close(4003,'device registration revoked');return;}
      const record:DeviceRecord={
        ...existing,deviceId:attachment.deviceId!,label:name,
        lastSeenAt:existing?.lastSeenAt??new Date().toISOString(),
        state:existing?.state??"unknown",
      };
      await this.env.OAUTH_KV.put(key,JSON.stringify(record));
      ws.send(JSON.stringify({version:PROTOCOL_VERSION,type:"device.name.updated",
        messageId:crypto.randomUUID(),deviceId:"self",connectionEpoch:attachment.epoch,
        payload:{name,inReplyTo:msg.messageId}}));
      return;
    }
    if(msg.type==="operation.accepted") {
      this.pendingDispatches.delete(msg.operationId);
      this.ctx.storage.sql.exec("UPDATE ops SET status='accepted',accepted_at=COALESCE(accepted_at,?) WHERE id=? AND status IN ('dispatched','accepted')",Date.now(),msg.operationId);return;
    }
    if(msg.type==="operation.started") {
      this.pendingDispatches.delete(msg.operationId);
      this.ctx.storage.sql.exec("UPDATE ops SET status='running',started_at=COALESCE(started_at,?),accepted_at=COALESCE(accepted_at,?) WHERE id=? AND status IN ('dispatched','accepted','running')",Date.now(),Date.now(),msg.operationId);return;
    }
    if(msg.type==="operation.result.begin") {
      this.pendingDispatches.delete(msg.operationId);
      const row=this.lookup(msg.operationId);
      if(!row||row.status==="completed"||row.status==="failed"||row.status==="cancelled")return;
      const total=msg.payload.stdoutBytes+msg.payload.stderrBytes;
      if(total>LIMITS.operationOutputBytes) {this.finish(msg.operationId,failure("OUTPUT_LIMIT","Foreground text output limit exceeded"),"failed");return;}
      this.ctx.storage.sql.exec("UPDATE ops SET status='finalizing',stdout_bytes=?,stderr_bytes=? WHERE id=?",
        msg.payload.stdoutBytes,msg.payload.stderrBytes,msg.operationId);return;
    }
    if(msg.type==="operation.result.chunk") {
      const row=this.lookup(msg.operationId);
      if(!row || !FG.has(row.tool) || row.status!=="finalizing") return;
      if(utf8size(msg.payload.text)>LIMITS.resultChunkBytes) {
        this.finish(msg.operationId,failure("OUTPUT_LIMIT","Text chunk too large"),"failed");return;
      }
      const pendingBytes=utf8size(msg.payload.text);
      const used=Number((this.ctx.storage.sql.exec("SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS n FROM chunks WHERE op_id=?",msg.operationId).one() as Row).n);
      if(used+pendingBytes>LIMITS.operationOutputBytes) {
        this.finish(msg.operationId,failure("OUTPUT_LIMIT","Text history limit exceeded"),"failed");return;
      }
      const duplicate=this.ctx.storage.sql.exec("SELECT 1 FROM chunks WHERE op_id=? AND stream=? AND idx=?",msg.operationId,msg.payload.stream,msg.payload.chunkIndex).toArray().length>0;
      if(duplicate)return;
      if(!this.ensureHistoryCapacity(pendingBytes,msg.operationId)){this.finish(msg.operationId,failure("OUTPUT_LIMIT","DO text history budget exhausted"),"failed");return;}
      this.ctx.storage.sql.exec("INSERT INTO chunks(op_id,stream,idx,content) VALUES(?,?,?,?)",msg.operationId,msg.payload.stream,msg.payload.chunkIndex,msg.payload.text);
      this.setHistorySize(this.historySize()+pendingBytes);return;
    }
    if(msg.type==="operation.result.commit") {
      this.pendingDispatches.delete(msg.operationId);
      const row=this.lookup(msg.operationId);if(!row)return;
      if(row.status==="completed"||row.status==="failed"||row.status==="cancelled"){
        this.ackCommit(ws,msg.messageId,msg.operationId);return;
      }
      if(FG.has(row.tool)&&row.status!=="finalizing") {
        this.finish(msg.operationId,failure("RESULT_INVALID","Missing foreground text begin"),"failed");return;
      }
      const data=msg.payload.result;
      // Same head/tail algorithm as local DETAIL and Batch previews.
      // Query only the edges for large results: never load 16 MiB into a DO preview.
      const totalOutputBytes=Number(row.stdout_bytes??0)+Number(row.stderr_bytes??0);
      const clipped=totalOutputBytes>LIMITS.resultPreviewBytes;
      let preview;
      if(!clipped){
        const all=this.ctx.storage.sql.exec("SELECT content FROM chunks WHERE op_id=? ORDER BY stream,idx",msg.operationId).toArray() as Row[];
        preview=createPreview(all.map(r=>String(r.content)).join(""),LIMITS.resultPreviewBytes);
      }else{
        const first=this.ctx.storage.sql.exec("SELECT content FROM chunks WHERE op_id=? ORDER BY stream,idx LIMIT 8",msg.operationId).toArray() as Row[];
        const last=this.ctx.storage.sql.exec("SELECT content FROM chunks WHERE op_id=? ORDER BY stream DESC,idx DESC LIMIT 8",msg.operationId).toArray() as Row[];
        preview=previewFromEdges(first.map(r=>String(r.content)).join(""),
          last.reverse().map(r=>String(r.content)).join(""),totalOutputBytes,LIMITS.resultPreviewBytes);
      }
      this.finish(msg.operationId,{status:"completed",data,...(FG.has(row.tool)?{
        outputPreview:preview.text,previewTruncated:preview.truncated,outputPreviewMeta:preview,
        stdoutBytes:Number(row.stdout_bytes??0),stderrBytes:Number(row.stderr_bytes??0),totalOutputBytes,
        historyAvailable:true
      }: {})},"completed");
      this.ackCommit(ws,msg.messageId,msg.operationId);
      return;
    }
    if(msg.type==="operation.failed") this.finish(msg.operationId,failure(msg.payload.code,msg.payload.message,msg.operationId,msg.payload.partialResult),"failed");
    if(msg.type==="operation.cancelled") this.finish(msg.operationId,failure("CANCELLED",msg.payload.reason??"Cancelled",msg.operationId),"cancelled");
  }
  private ackCommit(ws:WebSocket,messageId:string,operationId:string){
    ws.send(JSON.stringify({
      version:PROTOCOL_VERSION,type:"control.ack",messageId:crypto.randomUUID(),deviceId:"self",
      connectionEpoch:this.epoch(),operationId,payload:{inReplyTo:messageId}
    }));
  }
  async webSocketClose(ws:WebSocket) {
    const attachment=ws.deserializeAttachment() as {epoch:number}|null;
    if(attachment?.epoch!==this.epoch()) return;
    for(const [id,waiter] of this.waiters){
      if(waiter.disconnectTimer)clearTimeout(waiter.disconnectTimer);
      if(waiter.suspendedAt===undefined){
        waiter.suspendedAt=Date.now();
        clearTimeout(waiter.timer);
      }
      waiter.disconnectTimer=setTimeout(()=>{
        if(this.currentSocket())return;
        this.finish(id,failure("DEVICE_DISCONNECTED","Device offline beyond grace interval; check operation history before retry",id),"unknown");
      },LIMITS.shortDisconnectGraceMs);
    }
  }
  async webSocketError(ws:WebSocket) {await this.webSocketClose(ws);}
}

