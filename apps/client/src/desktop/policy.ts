import {loadConfig} from '../daemon.js';
import {DEFAULT_DESKTOP_MODE,DEFAULT_DESKTOP_CURSOR,normalizeDesktopMode,normalizeDesktopCursor,type DesktopMode} from './defaults.js';

export type DesktopPolicy={mode:DesktopMode;cursor:boolean};

/** Read device-owned settings on demand; preserve explicit configuration overrides. */
export function desktopPolicy():DesktopPolicy{
  try{
    const config=loadConfig();
    return {mode:normalizeDesktopMode(config.desktopMode),cursor:normalizeDesktopCursor(config.desktopCursor)};
  }catch{return {mode:DEFAULT_DESKTOP_MODE,cursor:DEFAULT_DESKTOP_CURSOR};}
}
function reject(reason:string):never{
 throw Object.assign(new Error('DESKTOP_POLICY_DENIED: '+reason),{code:'DESKTOP_POLICY_DENIED'});
}
export function requireDesktopPermission(tool:string,input:Record<string,unknown>,
 policy:DesktopPolicy=desktopPolicy()):void{
 const action=String(input.action??'');
 const observation=['desktop_status','desktop_list','desktop_snapshot','desktop_find','desktop_get','desktop_wait'].includes(tool)||
   (tool==='desktop_session'&&['list','info'].includes(action));
 if(!observation&&policy.mode==='observe_only')
   reject('device configured for desktop observation only');
 const headed=input.interactionMode==='headed'||tool==='desktop_press'||tool==='desktop_pointer';
 if(headed&&policy.mode!=='headed_allowed')
   reject('physical desktop control is not authorized on this device');
 if(tool==='desktop_session'&&input.cursor===true&&!policy.cursor)
   reject('cursor overlay is disabled on this device');
}
