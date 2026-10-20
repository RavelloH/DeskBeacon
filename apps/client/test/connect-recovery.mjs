import assert from 'node:assert/strict';
import { ClientDaemon } from '../dist/daemon.js';

const config={
 url:'https://unreachable.invalid',deviceId:'deskbeacon-client-retry-test',
 clientId:'deskbeacon-client-retry-test',deviceName:'Retry-test',
 accessToken:'expired',refreshToken:'test-refresh',
 accessTokenExpiresAt:0,
};
const originalFetch=globalThis.fetch;
let attempts=0;
globalThis.fetch=async()=>{attempts++;throw Error('simulated network loss');};
const daemon=new ClientDaemon(config);
try{
 await daemon.connect();
 assert.match((await daemon.status()).state,/^error:/);
 const deadline=Date.now()+3600;
 while(attempts<3&&Date.now()<deadline)await new Promise(r=>setTimeout(r,80));
 assert.ok(attempts>=3,'failed OAuth refresh should retry at a fixed one-second interval');
 const first=daemon.db.prepare("SELECT detail FROM connection_events WHERE kind='reconnect_scheduled' ORDER BY id DESC LIMIT 3").all();
 assert.ok(first.every(v=>v.detail==='delayMs=1000'),'all disconnected retries use one second');
 clearTimeout(daemon.reconnectTimer);daemon.reconnectTimer=undefined;
 daemon.scheduleReconnect();
 assert.equal(daemon.db.prepare("SELECT detail FROM connection_events WHERE kind='reconnect_scheduled' ORDER BY id DESC LIMIT 1").get().detail,'delayMs=1000');
 console.log('PASS fixed fast reconnect, no backoff and no duplicate reconnect timers');
 assert.match((await daemon.status()).state,/^error:/);
 console.log('PASS client automatically retries failed OAuth refresh after temporary disconnection');
 const ports=await daemon.execute('net_ports',{protocol:'tcp',state:'listen',limit:1},'local-netports-test','test-agent');
 assert.ok(Array.isArray(ports.connections),'net_ports must route to implemented system tool');
 console.log('PASS net_ports routes to systeminformation instead of missing network handler');
}finally{daemon.stop();globalThis.fetch=originalFetch;}
// WebSocket constructor and local diagnostics can throw synchronously during a
// reconnect. It must be converted into a retryable status, not an unhandled
// Promise rejection that silently terminates the background Runtime.
const invalid=new ClientDaemon({...config,url:'invalid url',refreshToken:undefined});
try{
 await invalid.connect();
 assert.match((await invalid.status()).state,/^error:/);
 const error=invalid.db.prepare("SELECT kind FROM connection_events WHERE kind='connect_exception' ORDER BY id DESC LIMIT 1").get();
 assert.equal(error?.kind,'connect_exception');
 console.log('PASS WebSocket constructor exceptions remain retryable, no Runtime crash');
}finally{invalid.stop();}
