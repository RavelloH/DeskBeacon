import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const testDir=mkdtempSync(join(tmpdir(),'deskbeacon-connect-recovery-'));
process.env.DESKBEACON_DATA_DIR=testDir;
const {ClientDaemon}=await import('../dist/daemon.js');
const {flushLogs,closeLogs}=await import('../dist/diagnostics.js');
const events=async()=>{await flushLogs();return readFileSync(join(testDir,'logs','connection.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);};

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
 const first=(await events()).filter(v=>v.event?.type==='reconnect_scheduled').slice(-3);
 assert.ok(first.length>0&&first.every(v=>v.event.data.detail==='delayMs=1000'),'all disconnected retries use one second');
 clearTimeout(daemon.reconnectTimer);daemon.reconnectTimer=undefined;
 daemon.scheduleReconnect();
 assert.equal((await events()).filter(v=>v.event?.type==='reconnect_scheduled').at(-1)?.event.data.detail,'delayMs=1000');
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
 const error=(await events()).filter(v=>v.event?.type==='connect_exception').at(-1);
 assert.equal(error?.event.type,'connect_exception');
 console.log('PASS WebSocket constructor exceptions remain retryable, no Runtime crash');
}finally{invalid.stop();}

await closeLogs();rmSync(testDir,{recursive:true,force:true});
