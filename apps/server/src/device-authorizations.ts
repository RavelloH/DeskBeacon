import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";

type GrantList = Awaited<ReturnType<OAuthHelpers["listUserGrants"]>>;
export type OwnerGrant = GrantList["items"][number];

/**
 * Read the actual OAuth grants, not the separate device: label registry.
 * Fail closed if pagination is incomplete: never show an orphan as authorized.
 */
export async function listOwnerGrants(oauth:Pick<OAuthHelpers,"listUserGrants">):Promise<OwnerGrant[]>{
  const grants:OwnerGrant[]=[];
  const cursors=new Set<string>();
  let cursor:string|undefined;
  for(let page=0;page<40;page++){
    const result=await oauth.listUserGrants("owner",{limit:250,...(cursor?{cursor}:{})});
    grants.push(...result.items);
    if(!result.cursor)return grants;
    if(cursors.has(result.cursor))throw new Error("OAuth grant pagination repeated a cursor");
    cursors.add(result.cursor);
    cursor=result.cursor;
  }
  throw new Error("OAuth grant pagination limit exceeded");
}
export function activeDeviceClientIds(grants:readonly OwnerGrant[],exceptGrantId?:string):Set<string>{
  return new Set(grants.filter(grant=>grant.id!==exceptGrantId &&
    grant.scope.includes("deskbeacon:device") && Boolean(grant.clientId) &&
    (grant.expiresAt===undefined || grant.expiresAt>Date.now()/1000))
    .map(grant=>grant.clientId));
}
