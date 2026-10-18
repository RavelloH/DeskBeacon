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
 const deadline=Date.now()+5200;
 while(attempts<3&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.ok(attempts>=3,'failed refresh should retry every second, with no exponential backoff');
 const recent=daemon.db.prepare("SELECT detail FROM connection_events WHERE kind='reconnect_scheduled' ORDER BY id DESC LIMIT 3").all();
 assert.ok(recent.length>=2&&recent.every(e=>e.detail==='delayMs=1000'),'all retries must use a fixed one-second interval');
 console.log('PASS fixed 1s reconnect retries and persisted connection event diagnostics');
 assert.match((await daemon.status()).state,/^error:/);
 console.log('PASS client automatically retries failed OAuth refresh after temporary disconnection');
 const ports=await daemon.execute('net_ports',{protocol:'tcp',state:'listen',limit:1},'local-netports-test','test-agent');
 assert.ok(Array.isArray(ports.connections),'net_ports must route to implemented system tool');
 console.log('PASS net_ports routes to systeminformation instead of missing network handler');
}finally{daemon.stop();globalThis.fetch=originalFetch;}
