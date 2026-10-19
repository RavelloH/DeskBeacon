import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../src/api.js';

describe('device name registry', () => {
  it('preserves a custom KV name on every WebSocket reconnect', async () => {
    const record = {deviceId:'test-device',label:'Custom name',lastSeenAt:null,state:'offline'};
    const saved:any[]=[];
    let connectedDeviceId='';
    const env = {
      OAUTH_KV:{
        get:async ()=>record,
        put:async (_key:string,value:string)=>{saved.push(JSON.parse(value));}
      },
      DEVICE_SESSIONS:{
        idFromName:(id:string)=>id,
        get:()=>({fetch:async (request:Request)=>{
          connectedDeviceId=request.headers.get('x-device-id')??'';
          return new Response(null,{status:200});
        }})
      }
    };
    const ctx = {props:{kind:'device',deviceId:'test-device',deviceName:'Stale OAuth Grant name'},
      auth:{scope:['deskbeacon:device']}};
    const response=await handleApiRequest(new Request('https://example.test/device/connect',{
      headers:{upgrade:'websocket'}
    }),env as any,ctx as any,{} as any);
    expect(response.status).toBe(200);
    expect(connectedDeviceId).toBe('test-device');
    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe('Custom name');
    const info=await handleApiRequest(new Request('https://example.test/device/info'),
      env as any,ctx as any,{} as any);
    expect((await info.json()).label).toBe('Custom name');
  });
});
