/** Defaults for new and legacy DeskBeacon configurations. Explicit user choices are preserved. */
export const DEFAULT_DESKTOP_MODE='headed_allowed' as const;
export const DEFAULT_DESKTOP_CURSOR=true as const;
export type DesktopMode='observe_only'|'headless_only'|'headed_allowed';
export function normalizeDesktopMode(value:unknown):DesktopMode {
 return value==='observe_only'||value==='headless_only'||value==='headed_allowed'
  ?value:DEFAULT_DESKTOP_MODE;
}
export function normalizeDesktopCursor(value:unknown):boolean {
 return typeof value==='boolean'?value:DEFAULT_DESKTOP_CURSOR;
}
