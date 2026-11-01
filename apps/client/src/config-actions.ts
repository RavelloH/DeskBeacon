import {loadConfig,saveConfig} from './daemon.js';
import {normalizeDesktopMode,normalizeDesktopCursor} from './desktop/defaults.js';
import {normalizeServerUrl} from './command-palette.js';
import {logEvent} from './diagnostics.js';
import {validateProxyUrl,clearProxyCache} from './outbound-network.js';

/** The same display shape served to the TUI by config-get and to the CLI offline. */
export type ConfigView={name:string;url:string;activeUrl:string;pending:boolean;proxyAuto:boolean;proxyUrl:string|null;
 desktopMode:'observe_only'|'headless_only'|'headed_allowed';desktopCursor:boolean};
export function getConfigView():ConfigView{
 const cfg=loadConfig();
 return{name:cfg.deviceName,url:cfg.pendingUrl??cfg.url,activeUrl:cfg.url,pending:Boolean(cfg.pendingUrl),proxyAuto:cfg.proxyAuto===true,proxyUrl:cfg.proxyUrl??null,desktopMode:normalizeDesktopMode(cfg.desktopMode),desktopCursor:normalizeDesktopCursor(cfg.desktopCursor)};
}

/** Only local device users may change desktop permissions (CLI/TUI via local IPC). */
export function setDesktopConfig(key:'desktop-mode'|'desktop-cursor',value:string):ConfigView{
 const cfg=loadConfig();
 if(key==='desktop-mode'){
  if(!['observe_only','headless_only','headed_allowed'].includes(value))
   throw Error('desktop-mode 只能是 observe_only、headless_only 或 headed_allowed');
  cfg.desktopMode=value as 'observe_only'|'headless_only'|'headed_allowed';
 }else{
  if(!/^(true|false)$/i.test(value))throw Error('desktop-cursor 只能是 true 或 false');
  cfg.desktopCursor=value.toLowerCase()==='true';
 }
 saveConfig(cfg);
 logEvent('security','desktop.configuration_changed','info',{key,mode:cfg.desktopMode,cursor:cfg.desktopCursor===true});
 return getConfigView();
}

/** Changing the origin never transfers existing OAuth tokens to the new server. */
export function setPendingServerUrl(value:string):Pick<ConfigView,'url'|'activeUrl'|'pending'>{
 const url=normalizeServerUrl(value),cfg=loadConfig();
 const pendingUrl=url===cfg.url?undefined:url;
 saveConfig({...cfg,pendingUrl});
 if(pendingUrl)logEvent('security','server.origin_change_pending','warn',{previousOrigin:cfg.url,pendingOrigin:pendingUrl});
 return {url:pendingUrl??cfg.url,activeUrl:cfg.url,pending:Boolean(pendingUrl)};
}

/** Manual URL overrides discovery. CLI accepts the literal null to remove it. */
export function setProxyConfig(key:'proxy-auto'|'proxy-url',value:string):ConfigView{
 const cfg=loadConfig();
 if(key==='proxy-auto'){
  if(!/^(true|false)$/i.test(value))throw Error('proxy-auto 只能是 true 或 false');
  cfg.proxyAuto=value.toLowerCase()==='true';
 }else{
  cfg.proxyUrl=value.toLowerCase()==='null'?null:validateProxyUrl(value);
 }
 saveConfig(cfg);
 clearProxyCache();
 logEvent('connection','proxy.configuration_changed','info',{key,auto:cfg.proxyAuto===true,manual:!!cfg.proxyUrl});
 return getConfigView();
}
