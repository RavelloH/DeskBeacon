import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const password='local-integration-only';
const salt=randomBytes(16);
const value=pbkdf2Sync(password,salt,150000,32,'sha256');
const hash='pbkdf2-sha256$150000$'+salt.toString('base64url')+'$'+value.toString('base64url');
const lines=['OWNER_PASSWORD_HASH="'+hash+'"','OWNER_SESSION_SECRET="'+randomBytes(48).toString('hex')+'"'];
writeFileSync('E:/DeskBeacon/apps/server/.dev.vars',lines.join('\n')+'\n',{mode:0o600});
console.log('Local-only integration credentials created (ignored by Git).');
