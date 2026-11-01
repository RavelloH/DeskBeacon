import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDesktopPlatform } from './platform.js';

/** The npm package ships all native binaries; use the precise one without any shell/PATH lookup. */
export async function desktopExecutable():Promise<string>{
  const {os,architecture}=assertDesktopPlatform();
  const suffix=os==='win32'?'.exe':'';
  const binary='agent-desktop-'+os+'-'+architecture+suffix;
  // src/desktop compiles to dist/desktop; native package is a client runtime dependency.
  const path=join(dirname(fileURLToPath(import.meta.url)),'..','..','node_modules',
    'agent-desktop','bin',binary);
  try{await access(path,os==='win32'?constants.F_OK:constants.X_OK);}
  catch{throw Error('DESKTOP_EXECUTABLE_UNAVAILABLE: native agent-desktop binary is missing: '+binary);}
  return path;
}
