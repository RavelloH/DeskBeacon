import {loadConfig,saveConfig} from './daemon.js';
import {normalizeServerUrl} from './command-palette.js';
import {logEvent} from './diagnostics.js';
import {validateProxyUrl,clearProxyCache} from './outbound-network.js';

/** The same display shape served to the TUI by config-get and to the CLI offline. */
export type ConfigView={name:string;url:string;activeUrl:string;pending:boolean;proxyAuto:boolean;proxyUrl:string|null};
export function getConfigView():ConfigView{
 const cfg=loadConfig();
 return{name:cfg.deviceName,url:cfg.pendingUrl??cfg.url,activeUrl:cfg.url,pending:Boolean(cfg.pendingUrl),proxyAuto:cfg.proxyAuto===true,proxyUrl:cfg.proxyUrl??null};
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
