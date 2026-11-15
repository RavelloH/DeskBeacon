import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'deskbeacon-config-recovery-'));
process.env.DESKBEACON_DATA_DIR=dir;
const {saveConfig,loadConfig,configPath}=await import('../dist/daemon.js');
const {configBackupPath}=await import('../dist/config-store.js');
const {saveSetupCredentials}=await import('../dist/setup-flow.js');
const {closeLogs}=await import('../dist/diagnostics.js');
const base={url:'https://original.example',deviceId:'original-id',clientId:'original-id',
 deviceName:'Original client',accessToken:'SECRET_ACCESS_ORIGINAL',refreshToken:'SECRET_REFRESH_ORIGINAL'};
function snapshot(path){return JSON.parse(readFileSync(path,'utf8'));}
try{
 saveConfig(base);
 assert.equal(snapshot(configPath).clientId,'original-id');
 assert.equal(snapshot(configBackupPath).clientId,'original-id');
 assert.equal(snapshot(configPath).configRevision,1);
 assert.equal(snapshot(configBackupPath).configRevision,1);
 assert.equal(loadConfig().desktopMode,'headed_allowed');
 assert.equal(loadConfig().desktopCursor,true);
 const preserved=readFileSync(configPath,'utf8');
 assert.throws(()=>saveConfig({...base,accessToken:''}),/CONFIG_INVALID/);
 assert.equal(readFileSync(configPath,'utf8'),preserved,'invalid settings must not touch disk');

 // A 471-byte all-zero primary is recovered from an independently flushed copy.
 writeFileSync(configPath,Buffer.alloc(471));
 let restored=loadConfig();
 assert.equal(restored.deviceId,'original-id');
 assert.equal(restored.refreshToken,base.refreshToken);
 assert.equal(snapshot(configPath).accessToken,base.accessToken);
 const archived=readdirSync(dir).filter(name=>name.startsWith('config.json.corrupt-'));
 assert.equal(archived.length,1,'damaged primary must be preserved for investigation');
 assert.equal(readFileSync(join(dir,archived[0])).length,471);

 // A crash after staging a rotated refresh token may leave *valid, stale*
 // primary JSON; revision comparison must choose the newer backup.
 const previous=readFileSync(configPath);
 saveConfig({...restored,accessToken:'SECRET_ACCESS_ROTATED',refreshToken:'SECRET_REFRESH_ROTATED'});
 assert.equal(snapshot(configBackupPath).configRevision,2);
 writeFileSync(configPath,previous);
 restored=loadConfig();
 assert.equal(restored.refreshToken,'SECRET_REFRESH_ROTATED');
 assert.equal(snapshot(configPath).configRevision,2);
 assert.ok(readdirSync(dir).some(name=>name.startsWith('config.json.stale-')));

 // Loss of primary is recoverable without pairing or a server round-trip.
 rmSync(configPath);
 assert.equal(loadConfig().deviceId,'original-id');
 assert.ok(existsSync(configPath));

 // A corrupted backup must not override a healthy primary.
 writeFileSync(configBackupPath,'not json');
 assert.equal(loadConfig().refreshToken,'SECRET_REFRESH_ROTATED');
 saveConfig(loadConfig());
 assert.equal(snapshot(configBackupPath).refreshToken,'SECRET_REFRESH_ROTATED');
 const staleSnapshot=loadConfig();
 saveConfig({...staleSnapshot,deviceName:'Updated name'});
 assert.throws(()=>saveConfig({...staleSnapshot,deviceName:'Overwritten by stale writer'}),/CONFIG_VERSION_CONFLICT/);
 assert.equal(loadConfig().deviceName,'Updated name','stale edits must not replace newer settings');

 // Both copies damaged: do not invent or silently reset the identity.
 writeFileSync(configPath,Buffer.alloc(471));
 writeFileSync(configBackupPath,'not json');
 assert.throws(()=>loadConfig(),/CONFIG_CORRUPTED/);
 // Explicit user re-pairing should still be possible, preserving the primary.
 saveSetupCredentials('https://new.example','new-client',
  {access_token:'NEW_ACCESS',refresh_token:'NEW_REFRESH',expires_in:3600});
 assert.equal(loadConfig().clientId,'new-client');
 assert.equal(snapshot(configBackupPath).refreshToken,'NEW_REFRESH');
 assert.ok(readdirSync(dir).filter(name=>name.startsWith('config.json.corrupt-')).length>=2);
 assert.ok(readdirSync(dir).some(name=>name.startsWith('config.json.bak.corrupt-')),
  'damaged backup should also be retained during explicit re-pairing');

 // No configuration at all: provide the setup hint rather than a parse error.
 rmSync(configPath);
 rmSync(configBackupPath);
 assert.throws(()=>loadConfig(),/DEVICE_NOT_CONFIGURED/);
 console.log('PASS config atomic snapshots, all-zero recovery, rotated-token revision, re-pair and evidence retention');
}finally{
 await closeLogs();
 rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
