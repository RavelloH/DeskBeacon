import {readFileSync} from 'node:fs';
declare const __DESKBEACON_PACKAGE_VERSION__:string;
export function codeVersion():string{
 if(typeof __DESKBEACON_PACKAGE_VERSION__!=='undefined')return __DESKBEACON_PACKAGE_VERSION__;
 const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
 return p.version;
}
