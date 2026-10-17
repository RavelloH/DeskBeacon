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
 assert.match(daemon.status().state,/^error:/);
 const deadline=Date.now()+6000;
 while(attempts<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.ok(attempts>=2,'refresh errors must schedule reconnect without manual restart');
 assert.match(daemon.status().state,/^error:/);
 console.log('PASS client automatically retries failed OAuth refresh after temporary disconnection');
 const ports=await daemon.execute('net_ports',{protocol:'tcp',state:'listen',limit:1},'local-netports-test','test-agent');
 assert.ok(Array.isArray(ports.connections),'net_ports must route to implemented system tool');
 console.log('PASS net_ports routes to systeminformation instead of missing network handler');
}finally{daemon.stop();globalThis.fetch=originalFetch;}
