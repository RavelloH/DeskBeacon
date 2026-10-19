/** Set a terminal-window title using OSC 0, independent of the TUI header. */
export function terminalWindowTitle(base:string,state:string,active=0):string{
 const safe=base.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,100)||'DeskBeacon';
 const normalized=state.toUpperCase().replace(/[^A-Z_]/g,'').slice(0,18)||'CONNECTING';
 return safe+' · '+normalized+(active>0?' · '+active+' RUNNING':'');
}
export function writeTerminalTitle(title:string,stream:Pick<NodeJS.WriteStream,'write'|'isTTY'>=process.stdout){
 if(!stream.isTTY)return;
 stream.write('\x1b]0;'+title.replace(/[\x00-\x1f\x7f-\x9f]/g,'').slice(0,180)+'\x07');
}
