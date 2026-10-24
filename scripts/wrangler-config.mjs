import ts from 'typescript';

const KV_BINDING = 'OAUTH_KV';
const UNSET_ID = /^0{32}$/;
const VALID_ID = /^[a-fA-F0-9]{32}$/;

/**
 * Adapt the one user-owned wrangler.jsonc for a single invocation of Wrangler.
 * Never write any changes back to the source: forks may keep their own IDs there.
 */
export function deploymentConfig(sourceText, env = process.env) {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', sourceText);
  if (parsed.error || !parsed.config || Array.isArray(parsed.config)) {
    throw new Error('Unable to parse root wrangler.jsonc');
  }
  const config = parsed.config;
  if (!Array.isArray(config.kv_namespaces)) {
    throw new Error('Root wrangler.jsonc needs an OAUTH_KV binding');
  }
  const kv = config.kv_namespaces.filter(item => item?.binding === KV_BINDING);
  if (kv.length !== 1) {
    throw new Error('Root wrangler.jsonc must have exactly one OAUTH_KV binding');
  }

  const input = env.DESKBEACON_OAUTH_KV_ID?.trim();
  if (input !== undefined && input !== '') {
    if (!VALID_ID.test(input) || UNSET_ID.test(input)) {
      throw new Error('DESKBEACON_OAUTH_KV_ID must be a nonzero 32-digit hex namespace ID');
    }
    kv[0].id = input;
  } else if (kv[0].id === undefined || kv[0].id === null || UNSET_ID.test(kv[0].id)) {
    // No ID lets Wrangler auto-provision/reuse the existing Worker binding.
    delete kv[0].id;
  } else if (typeof kv[0].id !== 'string' || !VALID_ID.test(kv[0].id)) {
    throw new Error('Invalid OAUTH_KV ID in root wrangler.jsonc');
  }

  const workerName = env.DESKBEACON_WORKER_NAME?.trim();
  if (workerName) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
      throw new Error('DESKBEACON_WORKER_NAME contains unsupported characters');
    }
    config.name = workerName;
  }
  return config;
}
