import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {decodeSgrMouse} from './action-link.js';

/** Defense in depth for terminals that emit a mouse CSI sequence in delayed fragments. */
export function stripMouseControlText(text:string):string{
 return text.replace(/\x1b?\[<\d+;\d+;\d+[mM]/g,'');
}
type Source=NodeJS.ReadableStream&{isTTY?:boolean;setRawMode?:(enabled:boolean)=>unknown;ref?:()=>unknown;unref?:()=>unknown};
type KeyInput=PassThrough&{isTTY?:boolean;setRawMode?:(enabled:boolean)=>unknown;ref?:()=>unknown;unref?:()=>unknown};

/**
 * Ink owns keyboard input, DeskBeacon owns SGR mouse input.
 * The latter must never enter Ink's useInput parser (which treats it as text).
 * Buffer incomplete SGR packets across read boundaries, without suppressing
 * ordinary CSI arrows, standalone Escape, Unicode, or typed punctuation.
 */
export class TuiInputBridge {
 readonly keyboard:KeyInput;
 readonly mouse=new EventEmitter();
 private readonly decoder=new StringDecoder('utf8');
 private pending='';
 private flushTimer:ReturnType<typeof setTimeout>|undefined;
 private readonly onData=(chunk:Buffer|string)=>this.feed(chunk);
 constructor(private readonly source:Source){
  const input=new PassThrough() as KeyInput;
  input.isTTY=Boolean(source.isTTY);
  input.setRawMode=(enabled)=>{source.setRawMode?.(enabled);return input;};
  input.ref=()=>{source.ref?.();return input;};
  input.unref=()=>{source.unref?.();return input;};
  this.keyboard=input;
  source.on('data',this.onData);
 }
 private scheduleFlush(){
  if(this.flushTimer)clearTimeout(this.flushTimer);
  if(this.pending){
   // Mouse CSI reports may arrive in fragments across event-loop turns.
   // Never forward incomplete mouse reports to Ink as keyboard input.
   const mousePrefix=/^\x1b\[<[0-9;]*$/.test(this.pending);
   const introducer='\x1b[<'.startsWith(this.pending);
   this.flushTimer=setTimeout(()=>{
    this.flushTimer=undefined;
    if(!this.pending)return;
    if(/^\x1b\[<[0-9;]*$/.test(this.pending))this.pending='';
    else {this.keyboard.write(this.pending);this.pending='';}
   },mousePrefix?80:introducer?25:0);
  }
 }
 feed(chunk:Buffer|string){
  this.pending+=this.decoder.write(typeof chunk==='string'?Buffer.from(chunk):chunk);
  let plain='';
  while(this.pending){
   const start=this.pending.indexOf('\x1b[<');
   if(start<0){
    // A mouse introducer can be split between chunks.
    let keep=0;
    for(let length=1;length<=3&&length<=this.pending.length;length++)
     if('\x1b[<'.startsWith(this.pending.slice(-length)))keep=length;
    plain+=this.pending.slice(0,this.pending.length-keep);
    this.pending=this.pending.slice(this.pending.length-keep);
    break;
   }
   if(start){plain+=this.pending.slice(0,start);this.pending=this.pending.slice(start);}
   const complete=/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
   if(complete){
    for(const event of decodeSgrMouse(complete[0]))this.mouse.emit('mouse',event);
    this.pending=this.pending.slice(complete[0].length);
    continue;
   }
   // Malformed or oversized packet: pass through rather than swallow input.
   if(this.pending.length<=64&&/^\x1b\[<[0-9;]*$/.test(this.pending))break;
   plain+=this.pending[0];
   this.pending=this.pending.slice(1);
  }
  if(plain)this.keyboard.write(plain);
  this.scheduleFlush();
 }
 dispose(){
  this.source.off('data',this.onData);
  if(this.flushTimer)clearTimeout(this.flushTimer);
  // No keyboard consumers remain: discard incomplete mouse CSI on teardown.
  this.pending='';
  this.keyboard.end();
  this.mouse.removeAllListeners();
 }
}
