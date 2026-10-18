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
 while(attempts<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.ok(attempts>=2,'failed refresh should retry after the initial three-second delay');
 const first=daemon.db.prepare("SELECT detail FROM connection_events WHERE kind='reconnect_scheduled' ORDER BY id DESC LIMIT 2").all();
 assert.deepEqual(first.map(v=>v.detail),['delayMs=8000','delayMs=3000']);
 // Sample later backoff stages without waiting for a prolonged artificial outage.
 clearTimeout(daemon.reconnectTimer);daemon.reconnectTimer=undefined;
 daemon.scheduleReconnect();
 clearTimeout(daemon.reconnectTimer);daemon.reconnectTimer=undefined;
 daemon.scheduleReconnect();
 const later=daemon.db.prepare("SELECT detail FROM connection_events WHERE kind='reconnect_scheduled' ORDER BY id DESC LIMIT 4").all();
 assert.deepEqual(later.map(v=>v.detail),['delayMs=30000','delayMs=20000','delayMs=8000','delayMs=3000']);
 console.log('PASS 3/8/20/30s bounded reconnect policy and connection event diagnostics');
 clearTimeout(daemon.reconnectTimer);daemon.reconnectTimer=undefined;
 const originalActive=daemon.supervisor.active.bind(daemon.supervisor);
 daemon.supervisor.active=()=>[{id:'in-flight-test',kind:'foreground'}];
 try{
  daemon.scheduleReconnect();
  const urgent=daemon.db.prepare("SELECT detail FROM connection_events WHERE kind='reconnect_scheduled' ORDER BY id DESC LIMIT 1").get();
  assert.equal(urgent.detail,'delayMs=3000','only live foreground work should override idle backoff');
 }finally{clearTimeout(daemon.reconnectTimer);daemon.reconnectTimer=undefined;daemon.supervisor.active=originalActive;}
 console.log('PASS active foreground command receives priority reconnect without idle reconnect spam');
 assert.match((await daemon.status()).state,/^error:/);
 console.log('PASS client automatically retries failed OAuth refresh after temporary disconnection');
 const ports=await daemon.execute('net_ports',{protocol:'tcp',state:'listen',limit:1},'local-netports-test','test-agent');
 assert.ok(Array.isArray(ports.connections),'net_ports must route to implemented system tool');
 console.log('PASS net_ports routes to systeminformation instead of missing network handler');
}finally{daemon.stop();globalThis.fetch=originalFetch;}
