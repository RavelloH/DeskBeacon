import { platform, arch } from 'node:os';

/** Side-effect-free capability guard; check before loading or spawning agent-desktop. */
export type DesktopPlatformResult = {supported:true; os:string; architecture:string} |
  {supported:false; code:'DESKTOP_PLATFORM_UNSUPPORTED'; reason:string};

export function checkDesktopPlatform(
  os=platform(), architecture=arch(), env:NodeJS.ProcessEnv=process.env,
  glibcVersion=(process.report?.getReport?.() as {header?:{glibcVersionRuntime?:string}}|undefined)?.header?.glibcVersionRuntime,
):DesktopPlatformResult {
  const termux=!!(env.TERMUX_VERSION || env.ANDROID_ROOT || env.ANDROID_DATA ||
    (env.PREFIX||'').includes('com.termux'));
  if(os==='android'||termux)return {supported:false,code:'DESKTOP_PLATFORM_UNSUPPORTED',
    reason:'Android / Termux is not supported by agent-desktop'};
  if(!['win32','darwin','linux'].includes(os) || !['x64','arm64'].includes(architecture))
    return {supported:false,code:'DESKTOP_PLATFORM_UNSUPPORTED',
      reason:'Unsupported operating system or CPU architecture: '+os+'/'+architecture};
  if(os==='linux'){
    const match=/^(\d+)\.(\d+)/.exec(glibcVersion??'');
    if(!match || Number(match[1])<2 || (Number(match[1])===2 && Number(match[2])<35))
      return {supported:false,code:'DESKTOP_PLATFORM_UNSUPPORTED',
        reason:'agent-desktop requires glibc >= 2.35 on Linux (musl/unknown libc not supported)'};
  }
  return {supported:true,os,architecture};
}

export function assertDesktopPlatform():Extract<DesktopPlatformResult,{supported:true}>{
  const result=checkDesktopPlatform();
  if(!result.supported)throw Error(result.code+': '+result.reason);
  return result;
}
