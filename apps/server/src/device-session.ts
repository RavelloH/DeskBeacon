import { DurableObject } from "cloudflare:workers";
import { LIMITS, PROTOCOL_VERSION, ProtocolMessageSchema, type ProtocolMessage } from "@deskbeacon/protocol";
import type { Env } from "./env.js";

type Waiter = { resolve: (value: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout>; disconnectTimer?: ReturnType<typeof setTimeout> };
type Rpc = { name: string; input: Record<string, unknown>; grantId: string; operationId: string };
type Row = Record<string, any>;
const FG = new Set(["exec_foreground", "exec_batch"]);
const HISTORY = new Set(["operation_get", "operation_output"]);

function failure(code: string, message: string, operationId?: string): Record<string, unknown> {
  return { isError: true, code, message, ...(operationId ? { operationId } : {}) };
}
function json(value: unknown, status=200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
function utf8size(value: string) { return new TextEncoder().encode(value).byteLength; }

export class DeviceSession extends DurableObject<Env> {
  private waiters = new Map<string, Waiter>();
  private foregroundTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ops(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, idem TEXT UNIQUE, result TEXT, stdout_bytes INTEGER DEFAULT 0, stderr_bytes INTEGER DEFAULT 0)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chunks(op_id TEXT NOT NULL, stream TEXT NOT NULL, idx INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(op_id,stream,idx))");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS ops_expires ON ops(expires)");
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN request_hash TEXT");}catch{}
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fg_queue(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,enqueued INTEGER NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS fg_queue_deadline ON fg_queue(deadline)");
    try{ctx.storage.sql.exec("ALTER TABLE ops ADD COLUMN history_evicted INTEGER DEFAULT 0");}catch{}
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"));
  }

  private currentSocket(): WebSocket | null {
    return this.ctx.getWebSockets().find(ws => ws.readyState === WebSocket.OPEN) ?? null;
  }
  private epoch(): number {
    return Number((this.ctx.storage.sql.exec("SELECT value FROM state WHERE key='epoch'").toArray()[0] as Row | undefined)?.value ?? 0);
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
    if (pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(failure("INVALID_INPUT","Expected WebSocket upgrade"),426);
      const pair = new WebSocketPair();
      const client=pair[0]!;
      const server=pair[1]!;
      const next = this.epoch() + 1;
      for(const waiter of this.waiters.values())if(waiter.disconnectTimer){clearTimeout(waiter.disconnectTimer);delete waiter.disconnectTimer;}
      for(const old of this.ctx.getWebSockets()) if(old.readyState===WebSocket.OPEN) old.close(4001,"reconnected");
      this.ctx.storage.sql.exec("INSERT INTO state(key,value) VALUES('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(next));
      server.serializeAttachment({ epoch:next });
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ version:PROTOCOL_VERSION, type:"device.ready", messageId:crypto.randomUUID(),
        deviceId:"self", connectionEpoch:next, payload:{ready:true} }));
      return new Response(null, {status:101,webSocket:client});
    }
    if(pathname==="/rpc") {
      if(request.method!=="POST") return json(failure("INVALID_INPUT","POST required"),405);
      const body = await request.json().catch(()=>null) as Rpc|null;
      if(!body || typeof body.name!=="string" || typeof body.operationId!=="string" ||
        typeof body.grantId!=="string" || !body.input || typeof body.input!=="object")
        return json(failure("INVALID_INPUT","Invalid RPC message"),400);
      if(HISTORY.has(body.name)) return json(this.readHistory(body));
      if(FG.has(body.name)) {
        if(!this.currentSocket())return json(failure("DEVICE_OFFLINE","Device has no active WebSocket",body.operationId));
        const now=Date.now(), deadline=now+LIMITS.queueTtlMs;
        // This queue is for *live synchronous* MCP calls. On DO restart abandoned queue records
        // become unknown; DO must never silently replay a potentially side-effecting operation.
        this.ctx.storage.sql.exec("UPDATE fg_queue SET status='unknown' WHERE deadline<? AND status IN ('queued','dispatched')",now);
        const count=Number((this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM fg_queue WHERE status='queued'").one() as Row).n);
        if(count>=32)return json(failure("QUEUE_FULL","Foreground queue is full",body.operationId));
        this.ctx.storage.sql.exec("INSERT INTO fg_queue(id,grant_id,enqueued,deadline,status) VALUES(?,?,?,?,'queued')",
          body.operationId,body.grantId,now,deadline);
        const prior=this.foregroundTail;
        let release!:()=>void;
        this.foregroundTail=new Promise<void>(r => {release=r;});
        try {
          await prior;
          if(Date.now()>deadline){
            this.ctx.storage.sql.exec("UPDATE fg_queue SET status='timedout' WHERE id=?",body.operationId);
            return json(failure("QUEUE_TIMEOUT","Foreground queue timeout. Operation was never dispatched",body.operationId));
          }
          if(!this.currentSocket())return json(failure("DEVICE_OFFLINE","Device went offline before dispatch",body.operationId));
          this.ctx.storage.sql.exec("UPDATE fg_queue SET status='dispatched' WHERE id=?",body.operationId);
          return json(await this.dispatch(body));
        } finally {
          this.ctx.storage.sql.exec("DELETE FROM fg_queue WHERE id=?",body.operationId);
          release();
        }
      }
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
      return { operationId:opId,status:row.status,tool:row.tool,createdAt:row.created,historyEvicted:Boolean(row.history_evicted),
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
    const input=body.input;
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([body.name,input])));
    const requestHash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
    const existingKey=typeof body.input.idempotencyKey==="string" ? body.grantId+":"+body.input.idempotencyKey : null;
    if(existingKey) {
      const prev=this.ctx.storage.sql.exec("SELECT id,status,result,request_hash FROM ops WHERE idem=?",existingKey).toArray()[0] as Row|undefined;
      if(prev && prev.request_hash!==requestHash) return failure("DUPLICATE_OPERATION","Idempotency key already used with different tool parameters",prev.id);
      if(prev) return prev.result && prev.status==="completed"
        ? {operationId:prev.id,...JSON.parse(prev.result)}
        : failure("OPERATION_UNKNOWN","Idempotent operation is still active or its final state is uncertain",prev.id);
    }
    if(!this.currentSocket()) return failure("DEVICE_OFFLINE","Device has no active WebSocket",body.operationId);
    const opId=body.operationId;
    const timeout=Math.min(LIMITS.maxForegroundTimeoutMs,Math.max(1000,Number(body.input.timeoutMs??(isFg?LIMITS.defaultForegroundTimeoutMs:30_000))));
    const expires=Date.now()+timeout+10_000;
    this.ctx.storage.sql.exec("INSERT INTO ops(id,grant_id,tool,status,created,expires,idem,request_hash) VALUES(?,?,?,?,?,?,?,?)",
      opId,body.grantId,body.name,"dispatched",Date.now(),Date.now()+LIMITS.operationTtlMs,existingKey,requestHash);
    const socket=this.currentSocket();
    if(!socket) {this.saveStatus(opId,"unknown");return failure("DEVICE_OFFLINE","Device disconnected",opId);}
    const epoch=(socket.deserializeAttachment() as {epoch?:number}|null)?.epoch??this.epoch();
    const response=new Promise<Record<string,unknown>>(resolve=>{
      const timer=setTimeout(()=>{
        this.waiters.delete(opId);
        this.ctx.storage.sql.exec("UPDATE ops SET status='unknown' WHERE id=? AND status NOT IN ('completed','failed')",opId);
        if(isFg && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify({
          version:PROTOCOL_VERSION,type:"foreground.cancel",messageId:crypto.randomUUID(),
          deviceId:"self",connectionEpoch:epoch,operationId:opId,payload:{reason:"server timeout"}
        }));
        resolve(failure("OPERATION_TIMEOUT","Operation deadline exceeded; execution state may be unknown",opId));
      },timeout+5_000);
      this.waiters.set(opId,{resolve,timer});
    });
    try {
      socket.send(JSON.stringify({version:PROTOCOL_VERSION,type:"operation.dispatch",messageId:crypto.randomUUID(),
        deviceId:"self",connectionEpoch:epoch,operationId:opId,grantId:body.grantId,
        expiresAt:new Date(expires).toISOString(),requestHash,toolName:body.name,input}));
    } catch(error) {
      this.finish(opId,failure("DEVICE_DISCONNECTED",String(error),opId),"unknown");
    }
    return await response;
  }

  private finish(id:string,result:Record<string,unknown>,status:string) {
    const row=this.lookup(id);
    if(!row) return;
    const fg=FG.has(row.tool);
    // Never persist transfer file contents, screenshots, or other binary-bearing tool data.
    const persist=fg ? result : (status==="completed"?{status:"completed"}:result);
    this.saveStatus(id,status,persist);
    const waiter=this.waiters.get(id);
    if(waiter){clearTimeout(waiter.timer);if(waiter.disconnectTimer)clearTimeout(waiter.disconnectTimer);this.waiters.delete(id);waiter.resolve({operationId:id,...result});}
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
    const attachment=ws.deserializeAttachment() as {epoch:number}|null;
    if(!attachment || attachment.epoch!==this.epoch()) {ws.close(4001,"stale device connection");return;}
    // File bytes are NEVER persisted; unsupported binary data must not be echoed into text tables.
    if(typeof raw!=="string") return;
    if(utf8size(raw)>LIMITS.controlFrameBytes) {ws.close(1009,"frame too large");return;}
    let msg:ProtocolMessage;
    try {msg=ProtocolMessageSchema.parse(JSON.parse(raw));} catch{return;}
    if(msg.connectionEpoch!==attachment.epoch) return;
    if(msg.type==="device.hello") return;
    if(msg.type==="operation.accepted") {
      this.ctx.storage.sql.exec("UPDATE ops SET status='accepted' WHERE id=? AND status='dispatched'",msg.operationId);return;
    }
    if(msg.type==="operation.started") {
      this.ctx.storage.sql.exec("UPDATE ops SET status='running' WHERE id=? AND status IN ('dispatched','accepted')",msg.operationId);return;
    }
    if(msg.type==="operation.result.begin") {
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
      const row=this.lookup(msg.operationId);if(!row)return;
      if(row.status==="completed"||row.status==="failed"||row.status==="cancelled"){
        this.ackCommit(ws,msg.messageId,msg.operationId);return;
      }
      if(FG.has(row.tool)&&row.status!=="finalizing") {
        this.finish(msg.operationId,failure("RESULT_INVALID","Missing foreground text begin"),"failed");return;
      }
      const data=msg.payload.result;
      const previewRows=this.ctx.storage.sql.exec("SELECT content FROM chunks WHERE op_id=? ORDER BY stream,idx LIMIT 20",msg.operationId).toArray() as Row[];
      let preview="";
      for(const r of previewRows){if(utf8size(preview)>=LIMITS.resultPreviewBytes)break;preview+=String(r.content).slice(0,LIMITS.resultPreviewBytes);}
      const previewBytes= new TextEncoder().encode(preview).slice(0,LIMITS.resultPreviewBytes);
      const outputPreview=new TextDecoder().decode(previewBytes);
      this.finish(msg.operationId,{status:"completed",data,...(FG.has(row.tool)?{
        outputPreview,previewTruncated:(row.stdout_bytes+row.stderr_bytes)>LIMITS.resultPreviewBytes,
        historyAvailable:true
      }: {})},"completed");
      this.ackCommit(ws,msg.messageId,msg.operationId);
      return;
    }
    if(msg.type==="operation.failed") this.finish(msg.operationId,failure(msg.payload.code,msg.payload.message,msg.operationId),"failed");
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
      waiter.disconnectTimer=setTimeout(()=>{
        if(this.currentSocket())return;
        this.finish(id,failure("DEVICE_DISCONNECTED","Device offline beyond grace interval; check operation history before retry",id),"unknown");
      },LIMITS.shortDisconnectGraceMs);
    }
  }
  async webSocketError(ws:WebSocket) {await this.webSocketClose(ws);}
}

