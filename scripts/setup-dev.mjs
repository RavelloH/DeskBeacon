import { existsSync, writeFileSync } from 'node:fs';
const path='E:/DeskBeacon/apps/server/.dev.vars';
if(existsSync(path)){console.error('Local .dev.vars already exists; refusing to overwrite credentials.');process.exitCode=1;}
else{writeFileSync(path,'MCP_AUTH_SECRET="local-integration-only"\n',{mode:0o600});console.log('Created ignored local OAuth test-only secret.');}
