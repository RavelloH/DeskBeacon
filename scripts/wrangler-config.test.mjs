import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentConfig} from './wrangler-config.mjs';

const config = `{
  // Fork owners may edit this file; the deploy script may not.
  "name":"deskbeacon",
  "main":"apps/server/src/index.ts",
  "build":{"command":"pnpm --filter @deskbeacon/protocol build"},
  "kv_namespaces":[{"binding":"OAUTH_KV","id":"00000000000000000000000000000000",}],
}`;
const ownId = '12ab34cd56ef78ab90cd12ef34ab56cd';

test('placeholder ID is omitted for auto-provisioning without changing source', () => {
  const result = deploymentConfig(config, {});
  assert.equal(result.kv_namespaces[0].id, undefined);
  assert.equal(result.main, 'apps/server/src/index.ts');
  assert.equal(result.build.command, 'pnpm --filter @deskbeacon/protocol build');
  assert.ok(config.includes('00000000000000000000000000000000'));
});
test('build environment overrides only temporary KV binding', () => {
  const result = deploymentConfig(config, {DESKBEACON_OAUTH_KV_ID: ownId});
  assert.equal(result.kv_namespaces[0].id, ownId);
  assert.ok(config.includes('00000000000000000000000000000000'));
});
test('nonzero fork-owned config ID is preserved without environment override', () => {
  const result = deploymentConfig(config.replace('0'.repeat(32), ownId), {});
  assert.equal(result.kv_namespaces[0].id, ownId);
});
test('environment override takes priority over fork config', () => {
  const other = 'abcd'.repeat(8);
  const result = deploymentConfig(config.replace('0'.repeat(32), ownId), {DESKBEACON_OAUTH_KV_ID: other});
  assert.equal(result.kv_namespaces[0].id, other);
});
test('invalid and placeholder KV IDs are refused', () => {
  for (const id of ['nope', '0'.repeat(32), ' '.repeat(32)]) {
    if (!id.trim()) continue;
    assert.throws(() => deploymentConfig(config, {DESKBEACON_OAUTH_KV_ID:id}), /DESKBEACON_OAUTH_KV_ID/);
  }
});
test('optional worker name is strictly validated', () => {
  assert.equal(deploymentConfig(config, {DESKBEACON_WORKER_NAME:'my-beacon'}).name, 'my-beacon');
  assert.throws(() => deploymentConfig(config, {DESKBEACON_WORKER_NAME:'Invalid Name'}), /DESKBEACON_WORKER_NAME/);
});
test('missing or ambiguous OAuth KV binding is never silently accepted', () => {
  assert.throws(() => deploymentConfig(config.replace('OAUTH_KV','OTHER_KV'), {}), /OAUTH_KV/);
  assert.throws(() => deploymentConfig(config.replace('"kv_namespaces":[{"binding":"OAUTH_KV","id":"00000000000000000000000000000000",}]', '"kv_namespaces":[]'), {}), /OAUTH_KV/);
});
