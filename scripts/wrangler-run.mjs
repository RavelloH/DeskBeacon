import {readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {deploymentConfig} from './wrangler-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, 'wrangler.jsonc');
const mode = process.argv[2] ?? 'deploy';
if (!['deploy', 'build', 'dev'].includes(mode)) {
  throw new Error('Usage: node scripts/wrangler-run.mjs [deploy|build|dev]');
}

const source = readFileSync(sourcePath, 'utf8');
const transformed = deploymentConfig(source);
const tempName = `.wrangler.generated.${process.pid}-${randomBytes(6).toString('hex')}.json`;
const tempPath = join(root, tempName);
// The generated file lives beside wrangler.jsonc so its relative main/build paths
// resolve exactly as they do in the user's original file.
writeFileSync(tempPath, `${JSON.stringify(transformed, null, 2)}\n`, {flag: 'wx', mode: 0o600});
try {
  const command = mode === 'dev' ? 'dev' : 'deploy';
  const args = ['--filter', '@deskbeacon/server', 'exec', 'wrangler', command,
    '--config', `../../${basename(tempPath)}`];
  if (mode === 'deploy') args.push('--keep-vars');
  if (mode === 'build') args.push('--dry-run', '--outdir=dist');
  const usingPnpmJs = /\.(?:cjs|mjs|js)$/.test(process.env.npm_execpath ?? '');
  const executable = usingPnpmJs ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const argv = usingPnpmJs ? [process.env.npm_execpath, ...args] : args;
  const result = spawnSync(executable, argv, {
    cwd: root,
    stdio: 'inherit',
    shell: !usingPnpmJs && process.platform === 'win32',
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
} finally {
  // Do not modify the checked-in root wrangler.jsonc, even if Wrangler fails.
  unlinkSync(tempPath);
}
