import { describe, it, expect } from 'vitest';
import { dispatchTool } from '../src/api.js';

describe('device_list live status', () => {
  it('returns actual online/offline DO state rather than stale KV state', async () => {
    const ids = ['online-device', 'offline-device'];
    const fakeEnv = {
      OAUTH_KV: {
        list: async () => ({ keys: ids.map(id => ({name: 'device:' + id})), list_complete: true }),
        get: async (key: string) => ({deviceId: key.slice('device:'.length), label:'Test', lastSeenAt:null,state:'unknown'})
      },
      DEVICE_SESSIONS: {
        idFromName: (id:string) => id,
        get: (id:string) => ({
          fetch: async () => Response.json({online:id==='online-device',epoch:1})
        })
      }
    };
    const result = await dispatchTool(fakeEnv as any, 'device_list', {}, 'test-grant') as any;
    expect(result.onlineStatus).toBe('checked on request');
    expect(result.devices.map((x:any)=>[x.deviceId,x.state])).toEqual([
      ['online-device','online'],['offline-device','offline']
    ]);
  });
});
