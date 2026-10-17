import assert from 'node:assert/strict';
import { ClientDaemon } from '../dist/daemon.js';
import { startIpc, requestIpc } from '../dist/ipc.js';
const config={url:'http://localhost:8787',deviceId:'local-ipc-test',
 clientId:'local-ipc-test',accessToken:'test-only',deviceName:'Local IPC test'};
const daemon=new ClientDaemon(config);
const listener=startIpc(daemon);
try{
 await new Promise(r=>setTimeout(r,300));
 const status=await requestIpc({action:'status'});
 assert.equal(status.deviceId,'local-ipc-test');
 console.log('PASS local IPC status');
 const id=daemon.db.prepare('SELECT id FROM activity WHERE tool=? ORDER BY time DESC LIMIT 1').get('exec_foreground');
 if(id){
  const logs=await requestIpc({action:'logs',operationId:id.id});
  assert.ok(Array.isArray(logs.outputs));
  console.log('PASS local TUI history output',logs.outputs.length);
 }
 const stop=await requestIpc({action:'stop',taskId:'not-running'});
 assert.equal(stop.stopped,false);
 console.log('PASS local stop idempotent for absent task');
}finally{
 await new Promise(r=>listener.close(r));
 daemon.stop();
}
