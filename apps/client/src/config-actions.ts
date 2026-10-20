import {loadConfig,saveConfig} from './daemon.js';
import {normalizeServerUrl} from './command-palette.js';

/** The same display shape served to the TUI by config-get and to the CLI offline. */
export type ConfigView={name:string;url:string;activeUrl:string;pending:boolean};
export function getConfigView():ConfigView{
 const cfg=loadConfig();
 return{name:cfg.deviceName,url:cfg.pendingUrl??cfg.url,activeUrl:cfg.url,pending:Boolean(cfg.pendingUrl)};
}

/** Changing the origin never transfers existing OAuth tokens to the new server. */
export function setPendingServerUrl(value:string):Pick<ConfigView,'url'|'activeUrl'|'pending'>{
 const url=normalizeServerUrl(value),cfg=loadConfig();
 const pendingUrl=url===cfg.url?undefined:url;
 saveConfig({...cfg,pendingUrl});
 return {url:pendingUrl??cfg.url,activeUrl:cfg.url,pending:Boolean(pendingUrl)};
}
