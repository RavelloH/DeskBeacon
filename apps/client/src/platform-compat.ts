import {accessSync, constants, statfsSync} from 'node:fs';
import {availableParallelism,cpus,homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Android Node builds may expose no CPU details despite available cores.
export function cpuCount():number {
  const cores=cpus().length;
  if(cores>0)return cores;
  try{const available=availableParallelism();if(Number.isFinite(available)&&available>0)return available;}catch{}
  return 1;
}

// POSIX executable lookup cannot rely on the optional which command.
export function availableShells(platform=process.platform,path=process.env.PATH??''):string[]{
  const names=platform==='win32'?['pwsh.exe','powershell.exe','cmd.exe','bash.exe','wsl.exe']:
    ['bash','zsh','sh','pwsh'];
  if(platform==='win32')return names.filter(name=>spawnSync('where.exe',[name],{windowsHide:true,timeout:2000}).status===0);
  const directories=path.split(':').filter(Boolean);
  return names.filter(name=>directories.some(directory=>{
    try{accessSync(join(directory,name),constants.X_OK);return true;}catch{return false;}
  }));
}

export function browserOpenCommand(url:string,platform=process.platform):{program:string;args:string[]} {
  if(platform==='win32')return{program:'rundll32.exe',args:['url.dll,FileProtocolHandler',url]};
  if(platform==='darwin')return{program:'open',args:[url]};
  if(platform==='android')return{program:'termux-open-url',args:[url]};
  return{program:'xdg-open',args:[url]};
}

// systeminformation.fsSize() may expose no mounts on Android.
export function androidHomeDiskSnapshot(directory=homedir()):{mount:string;totalBytes:number;usedBytes:number;usedPercent:number}[] {
  try{
    const info=statfsSync(directory,{bigint:true});
    const totalBytes=Number(info.blocks*info.bsize);
    const freeBytes=Number(info.bfree*info.bsize);
    if(!Number.isSafeInteger(totalBytes)||totalBytes<=0||!Number.isSafeInteger(freeBytes))return [];
    const usedBytes=Math.max(0,totalBytes-freeBytes);
    return[{mount:directory,totalBytes,usedBytes,usedPercent:Math.round(10000*usedBytes/totalBytes)/100}];
  }catch{return [];}
}
