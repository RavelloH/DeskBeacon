/** DeskBeacon-local ownership for native Agent Desktop snapshot references.
 * --agent-id changes the native namespace but DOES NOT authorize reads across agents.
 * Treat native refs as opaque capabilities scoped to the OAuth grant AND native session.
 */
const REF=/^@(s[a-zA-Z0-9]+):e\d+$/;
const MAX_SNAPSHOTS=2048;
const MAX_AGE_MS=2*60*60*1000;
type Owner={grantId:string;sessionId:string;seenAt:number};

export class DesktopRefOwnership {
 private owners=new Map<string,Owner>();
 constructor(private readonly now:()=>number=Date.now){}
 private trim():void{
  const cutoff=this.now()-MAX_AGE_MS;
  for(const [key,owner] of this.owners)if(owner.seenAt<cutoff)this.owners.delete(key);
  while(this.owners.size>MAX_SNAPSHOTS)this.owners.delete(this.owners.keys().next().value!);
 }
 /** Record only refs that originated in a successful UI result delivered to this grant. */
 remember(result:unknown,grantId:string,sessionId:string):void{
  if(!result||typeof result!=='object')return;
  const envelope=result as Record<string,unknown>;
  if(envelope.ok!==true)return;
  const ids=new Set<string>();
  const visit=(node:unknown,depth:number):void=>{
   if(depth>40||!node||typeof node!=='object')return;
   if(Array.isArray(node)){for(const item of node)visit(item,depth+1);return;}
   const record=node as Record<string,unknown>;
   if(typeof record.snapshot_id==='string'&&/^s[a-zA-Z0-9]+$/.test(record.snapshot_id))
    ids.add(record.snapshot_id);
   if(typeof record.ref_id==='string'){
    const match=REF.exec(record.ref_id);if(match)ids.add(match[1]!);
   }
   for(const [key,value] of Object.entries(record)){
    if(key==='value'||key==='text'||key==='base64')continue;
    if(value&&typeof value==='object')visit(value,depth+1);
   }
  };
  visit(envelope.data,0);
  this.trim();
  for(const snapshotId of ids){
   const previous=this.owners.get(snapshotId);
   // Fail closed if a native ID unexpectedly collides across grants or sessions.
   if(previous&&(previous.grantId!==grantId||previous.sessionId!==sessionId))continue;
   this.owners.delete(snapshotId);
   this.owners.set(snapshotId,{grantId,sessionId,seenAt:this.now()});
  }
  this.trim();
 }
 /** Reject unknown, expired, cross-agent or cross-session refs before native invocation. */
 assertInputs(input:Record<string,unknown>,grantId:string,sessionId:string):void{
  this.trim();
  for(const key of ['refId','rootRef','fromRef','toRef'] as const){
   const ref=input[key];
   if(ref===undefined||ref===null)continue;
   if(typeof ref!=='string')throw this.forbidden('invalid reference');
   const match=REF.exec(ref);
   if(!match)throw this.forbidden('invalid reference');
   const owner=this.owners.get(match[1]!);
   if(!owner||owner.grantId!==grantId||owner.sessionId!==sessionId)
    throw this.forbidden('reference is unknown, expired or belongs to another Agent or session');
  }
 }
 clearSession(sessionId:string):void{
  for(const [key,owner] of this.owners)
   if(owner.sessionId===sessionId)this.owners.delete(key);
 }
 clear():void{this.owners.clear();}
 private forbidden(message:string):Error{
  return Object.assign(new Error('DESKTOP_REF_FORBIDDEN: '+message),
   {code:'DESKTOP_REF_FORBIDDEN',partialResult:{disposition:{delivery:'not_delivered',retry:'safe'},
    suggestion:'Refresh the accessibility snapshot with the current Agent before using this reference.'}});
 }
}