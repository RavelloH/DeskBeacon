import {writeSync} from 'node:fs';
import {logCriticalTuiSync} from './diagnostics.js';

// Both Win32 Console and xterm-compatible terminals understand these modes.
// Disabling mouse reporting *before* leaving the alternate screen prevents
// late mouse reports from being echoed into PowerShell on normal termination.
export const TUI_ENTER_TERMINAL='\x1b[?1049h\x1b[?1003h\x1b[?1006h';
export const TUI_RESTORE_TERMINAL='\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l';

export function installTuiTerminalGuard(
 stdout:NodeJS.WriteStream=process.stdout,
 stdin:NodeJS.ReadStream=process.stdin,
 host:NodeJS.Process=process,
 recordCritical:(event:string,details:Record<string,unknown>)=>void=logCriticalTuiSync,
){
 let active=false;
 const restoreSync=()=>{
  if(!active)return;
  active=false;
  if(stdout.isTTY){
   // The exit event cannot await async streams; write synchronously to the
   // console where possible. This works for normal exits and JS exceptions,
   // but not for externally forced OS-level TerminateProcess / SIGKILL.
   try{writeSync((stdout as NodeJS.WriteStream&{fd?:number}).fd??1,TUI_RESTORE_TERMINAL);}
   catch{try{stdout.write(TUI_RESTORE_TERMINAL);}catch{}}
  }
  try{stdin.setRawMode?.(false);}catch{}
 };
 const onCrash=(error:Error,origin:string)=>{
  recordCritical('session.uncaught',{origin,error});
  restoreSync();
 };
 const onExit=()=>restoreSync();
 const onSignal=(signal:string,exitCode:number)=>()=>{
  recordCritical('session.signal_exit',{signal,exitCode});
  restoreSync();
  // Signal handlers override Node's default termination, so exit explicitly.
  host.exitCode=exitCode;
  host.exit();
 };
 const onSigint=onSignal('SIGINT',130);
 const onSigterm=onSignal('SIGTERM',143);
 const onSigbreak=onSignal('SIGBREAK',149);
 host.on('exit',onExit);
 host.on('uncaughtExceptionMonitor',onCrash);
 host.on('SIGINT',onSigint);
 host.on('SIGTERM',onSigterm);
 if(process.platform==='win32')host.on('SIGBREAK',onSigbreak);
 return {
  enter(){
   if(stdout.isTTY){active=true;stdout.write(TUI_ENTER_TERMINAL);}
  },
  async restore(){
   if(!active)return;
   active=false;
   if(stdout.isTTY){
    await new Promise<void>(resolve=>stdout.write(TUI_RESTORE_TERMINAL,()=>resolve()));
   }
   try{stdin.setRawMode?.(false);}catch{}
  },
  dispose(){
   host.off('exit',onExit);
   host.off('uncaughtExceptionMonitor',onCrash);
   host.off('SIGINT',onSigint);
   host.off('SIGTERM',onSigterm);
   if(process.platform==='win32')host.off('SIGBREAK',onSigbreak);
  },
 };
}
