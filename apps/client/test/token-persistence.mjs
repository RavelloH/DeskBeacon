import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'deskbeacon-token-persistence-'));
process.env.DESKBEACON_DATA_DIR=dir;
const {ClientDaemon,saveConfig,loadConfig}=await import('../dist/daemon.js');
let requests=0;
const server=createServer(async(req,res)=>{
 requests++;
 assert.equal(req.url,'/oauth/token');
 res.writeHead(200,{'content-type':'application/json'});
 res.end(JSON.stringify({access_token:'NEW_TOKEN',refresh_token:'NEW_REFRESH',expires_in:3600}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const base={url:'http://127.0.0.1:'+port,deviceId:'old-device',clientId:'old-device',
 deviceName:'old device',accessToken:'OLD_TOKEN',refreshToken:'OLD_REFRESH',
 accessTokenExpiresAt:0};
let daemon;
try{
 saveConfig(base);
 daemon=new ClientDaemon(loadConfig());
 // Another pairing altered the on-disk identity during an HTTP refresh.
 // This models persistence failure without OS-specific ACL manipulation.
 saveConfig({...base,deviceId:'other-device',clientId:'other-device'});
 await assert.rejects(daemon.refreshAccessToken(),/DEVICE_CONFIG_CHANGED_DURING_TOKEN_REFRESH/);
 assert.equal(requests,1);
 assert.equal(loadConfig().refreshToken,'OLD_REFRESH');
 assert.equal(daemon.credentialsNeedSaving,true);
 // Once the disk identity is restored, retry ONLY the local save. Never
 // attempt to redeem an already rotated refresh token for a second time.
 saveConfig(base);
 await daemon.refreshAccessToken();
 assert.equal(requests,1,'a failed local save must not make a second refresh request');
 assert.equal(loadConfig().accessToken,'NEW_TOKEN');
 assert.equal(loadConfig().refreshToken,'NEW_REFRESH');
 assert.equal(loadConfig().deviceId,'old-device');
 assert.equal(daemon.credentialsNeedSaving,false);
 console.log('PASS rotated credentials are retried locally without replaying the OAuth refresh');
}finally{
 daemon?.stop();
 await new Promise(resolve=>server.close(resolve));
 rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
