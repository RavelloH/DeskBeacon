import {chmodSync,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {normalizeDesktopMode,normalizeDesktopCursor} from './desktop/defaults.js';

export type Config={url:string;deviceId:string;accessToken:string;refreshToken?:string|undefined;accessTokenExpiresAt?:number|undefined;clientId:string;deviceName:string;pendingUrl?:string|undefined;proxyAuto?:boolean|undefined;proxyUrl?:string|null|undefined;desktopMode?:'observe_only'|'headless_only'|'headed_allowed'|undefined;desktopCursor?:boolean|undefined;configRevision?:number|undefined};
export const dataDir=process.env.DESKBEACON_DATA_DIR ?? join(homedir(),'.deskbeacon');
export const configPath=join(dataDir,'config.json');
export const configBackupPath=configPath+'.bak';

const required=['url','deviceId','clientId','deviceName','accessToken'] as const;
function validate(value:unknown):Config{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CONFIG_INVALID');
 const record=value as Record<string,unknown>;
 for(const key of required)if(typeof record[key]!=='string'||!(record[key] as string).trim())throw Error('CONFIG_INVALID: '+key);
 try{
  const url=new URL(record.url as string);
  if(!['https:','http:'].includes(url.protocol)||!url.hostname)throw Error('invalid');
 }catch{throw Error('CONFIG_INVALID: url');}
 if(record.refreshToken!==undefined&&typeof record.refreshToken!=='string')throw Error('CONFIG_INVALID: refreshToken');
 if(record.accessTokenExpiresAt!==undefined&&(!Number.isFinite(record.accessTokenExpiresAt)||typeof record.accessTokenExpiresAt!=='number'))throw Error('CONFIG_INVALID: accessTokenExpiresAt');
 if(record.pendingUrl!==undefined&&typeof record.pendingUrl!=='string')throw Error('CONFIG_INVALID: pendingUrl');
 if(record.proxyAuto!==undefined&&typeof record.proxyAuto!=='boolean')throw Error('CONFIG_INVALID: proxyAuto');
 if(record.proxyUrl!==undefined&&record.proxyUrl!==null&&typeof record.proxyUrl!=='string')throw Error('CONFIG_INVALID: proxyUrl');
 if(record.desktopMode!==undefined&&!['observe_only','headless_only','headed_allowed'].includes(record.desktopMode as string))throw Error('CONFIG_INVALID: desktopMode');
 if(record.desktopCursor!==undefined&&typeof record.desktopCursor!=='boolean')throw Error('CONFIG_INVALID: desktopCursor');
 if(record.configRevision!==undefined&&(!Number.isSafeInteger(record.configRevision)||Number(record.configRevision)<1))throw Error('CONFIG_INVALID: configRevision');
 return record as Config;
}
function normalized(value:Config):Config{
 const config=validate(value);
 return {...config,proxyAuto:config.proxyAuto===true,
  proxyUrl:typeof config.proxyUrl==='string'&&config.proxyUrl.trim()?config.proxyUrl:null,
  desktopMode:normalizeDesktopMode(config.desktopMode),desktopCursor:normalizeDesktopCursor(config.desktopCursor)};
}
function readValidated(path:string):Config{
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>1024*1024)throw Error('CONFIG_INVALID_FILE');
 return normalized(JSON.parse(readFileSync(path,'utf8')));
}
function recoverableReadError(error:unknown):boolean{
 if(error instanceof SyntaxError)return true;
 if(error instanceof Error&&error.message.startsWith('CONFIG_INVALID'))return true;
 return (error as NodeJS.ErrnoException)?.code==='ENOENT';
}
function atomicReplace(path:string,content:string):void{
 const temporary=path+'.'+process.pid+'.'+randomUUID()+'.tmp';
 let descriptor:number|undefined;
 try{
  descriptor=openSync(temporary,'wx',0o600);
  writeFileSync(descriptor,content,'utf8');
  fsyncSync(descriptor);
  closeSync(descriptor);descriptor=undefined;
  renameSync(temporary,path);
  if(process.platform!=='win32')chmodSync(path,0o600);
  // Flush directory metadata when supported; Windows rename itself is atomic
  // but a directory handle cannot reliably be fsynced through Node on Windows.
  if(process.platform!=='win32'){
   const dir=openSync(dirname(path),'r');
   try{fsyncSync(dir);}finally{closeSync(dir);}
  }
 }finally{
  if(descriptor!==undefined)closeSync(descriptor);
  try{rmSync(temporary,{force:true});}catch{}
 }
}
function quarantine(path:string,kind:'corrupt'|'stale'='corrupt'):string{
 const destination=path+'.'+kind+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
 renameSync(path,destination);
 return destination;
}
/** Write the new valid snapshot to the durable backup *before* switching the primary.
 * A crash on either side of the primary rename leaves at least one complete copy.
 * Both files contain credentials and use owner-only permissions where supported.
 */
export function saveConfig(config:Config):void{
 const stored=normalized(config);
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 let maxRevision=stored.configRevision??0;
 for(const path of [configPath,configBackupPath]){
  try{maxRevision=Math.max(maxRevision,readValidated(path).configRevision??0);}
  catch(error){if(!recoverableReadError(error))throw error;}
 }
 // Callers that edited a loaded snapshot must not silently overwrite a newer
 // revision written by another process. Fresh pairing has no prior revision.
 if(stored.configRevision!==undefined&&stored.configRevision<maxRevision)
  throw Error('CONFIG_VERSION_CONFLICT: reload configuration and retry');
 stored.configRevision=maxRevision+1;
 const content=JSON.stringify(stored,null,2);
 for(const path of [configPath,configBackupPath]){
  if(!existsSync(path))continue;
  try{readValidated(path);}
  catch(error){
   if(!recoverableReadError(error))throw error;
   // Preserve damaged bytes instead of overwriting evidence during re-pairing.
   quarantine(path);
  }
 }
 atomicReplace(configBackupPath,content);
 atomicReplace(configPath,content);
}
/** Recover an interrupted primary write without creating a new OAuth device. */
export function loadConfig():Config{
 let primary:Config|undefined,backup:Config|undefined;
 try{primary=readValidated(configPath);}catch(error){if(!recoverableReadError(error))throw error;}
 try{backup=readValidated(configBackupPath);}catch(error){if(!recoverableReadError(error))throw error;}
 // The backup is staged first: a crash between the two atomic replacements
 // can leave a *valid but older* primary with an already-rotated OAuth token.
 if(primary&&(!backup||(primary.configRevision??0)>=(backup.configRevision??0)))return primary;
 if(backup){
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  if(existsSync(configPath))quarantine(configPath,primary?'stale':'corrupt');
  atomicReplace(configPath,JSON.stringify(backup,null,2));
  console.warn('DeskBeacon: recovered the newest valid configuration from the local backup.');
  return backup;
 }
 if(!existsSync(configPath)&&!existsSync(configBackupPath))
  throw Error('DEVICE_NOT_CONFIGURED: run deskbeacon setup --url https://your-worker.example');
 throw Error('CONFIG_CORRUPTED: config.json and its backup are unreadable; preserve them and run deskbeacon setup --url https://your-worker.example');
}
