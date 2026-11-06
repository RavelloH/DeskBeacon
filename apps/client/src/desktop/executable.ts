import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { assertDesktopPlatform } from './platform.js';

/** Resolve from this module's installation, not a fixed parent directory.
 * In a packed npm release this module is bundled into cli.js, while in dev it is
 * compiled into dist/desktop. Node's package resolver handles both layouts. */
export function resolveDesktopBinary(binary:string,moduleUrl:string=import.meta.url):string{
  try{return createRequire(moduleUrl).resolve('agent-desktop/bin/'+binary);}
  catch{throw Error('DESKTOP_EXECUTABLE_UNAVAILABLE: native agent-desktop binary is missing: '+binary);}
}

/** Use the exact installed native binary, never a PATH or shell lookup. */
export async function desktopExecutable():Promise<string>{
  const {os,architecture}=assertDesktopPlatform();
  const binary='agent-desktop-'+os+'-'+architecture+(os==='win32'?'.exe':'');
  const path=resolveDesktopBinary(binary);
  try{await access(path,os==='win32'?constants.F_OK:constants.X_OK);}
  catch{throw Error('DESKTOP_EXECUTABLE_UNAVAILABLE: native agent-desktop binary is missing: '+binary);}
  return path;
}
