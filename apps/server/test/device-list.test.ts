import { describe, it, expect } from 'vitest';
import { dispatchTool } from '../src/api.js';
import {listOwnerGrants,activeDeviceClientIds} from '../src/device-authorizations.js';

describe('device_list matches active OAuth grants', () => {
  const records=['online-device','offline-device','orphan-device'];
  function fixture(){
    const seen:string[]=[],reads:string[]=[];
    const env={
      OAUTH_KV:{
        list:async()=>({keys:records.map(id=>({name:'device:'+id})),list_complete:true}),
        get:async(key:string)=>{reads.push(key);return {deviceId:key.slice('device:'.length),label:'Test',lastSeenAt:null,state:'unknown'};}
      },
      DEVICE_SESSIONS:{
        idFromName:(id:string)=>id,
        get:(id:string)=>({fetch:async()=>{
          seen.push(id);
          return Response.json({online:id==='online-device',epoch:1});
        }})
      }
    };
    const oauth={
      listUserGrants:async(_user:string,opts:{cursor?:string})=>opts.cursor
        ?{items:[
          {id:'g2',clientId:'offline-device',scope:['deskbeacon:device']},
          {id:'g3',clientId:'orphan-agent',scope:['deskbeacon:agent']}
        ]}
        :{items:[{id:'g1',clientId:'online-device',scope:['deskbeacon:device']}],cursor:'page-2'}
    };
    return{env,oauth,seen,reads};
  }
  it('returns actual DO state for authorized devices, hides orphan KV records',async()=>{
    const {env,oauth,seen,reads}=fixture();
    const result=await dispatchTool(env as any,'device_list',{},'agent-grant','ChatGPT',oauth as any) as any;
    expect(result.onlineStatus).toBe('checked on request');
    expect(result.devices.map((x:any)=>[x.deviceId,x.state])).toEqual([
      ['online-device','online'],['offline-device','offline']
    ]);
    expect(seen).toEqual(['online-device','offline-device']);
    expect(reads).toEqual(['device:online-device','device:offline-device']);
  });
  it('fails closed if grant validation is unavailable',async()=>{
    const {env}=fixture();
    const result=await dispatchTool(env as any,'device_list',{},'agent-grant');
    expect(result).toMatchObject({isError:true,code:'OAUTH_UNAVAILABLE'});
  });
  it('rejects repeating pagination cursors instead of silently exposing stale entries',async()=>{
    const oauth={listUserGrants:async()=>({items:[],cursor:'loop'})};
    await expect(listOwnerGrants(oauth as any)).rejects.toThrow('repeated a cursor');
  });
  it('distinguishes Agent grants from Device grants, including exclusions',()=>{
    const grants=[
      {id:'one',clientId:'a',scope:['deskbeacon:device']},
      {id:'two',clientId:'a',scope:['deskbeacon:device']},
      {id:'three',clientId:'b',scope:['deskbeacon:agent']},
      {id:'expired',clientId:'expired-device',scope:['deskbeacon:device'],expiresAt:Math.floor(Date.now()/1000)-60}
    ];
    expect([...activeDeviceClientIds(grants as any,'one')]).toEqual(['a']);
    expect([...activeDeviceClientIds(grants as any,'two')]).toEqual(['a']);
    expect([...activeDeviceClientIds(grants as any)]).toEqual(['a']);
  });
});
