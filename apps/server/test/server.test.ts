import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_NAMES, toolInputSchemas } from '@deskbeacon/protocol';
const wrangler=JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url),'utf8'));
describe('Server static contract',()=>{
 it('declares only OAuth KV and per-device Durable Object bindings',()=>{
  expect(wrangler.kv_namespaces).toHaveLength(1);
  expect(wrangler.kv_namespaces[0].binding).toBe('OAUTH_KV');
  expect(wrangler.durable_objects.bindings).toEqual([{name:'DEVICE_SESSIONS',class_name:'DeviceSession'}]);
  expect(wrangler.d1_databases).toBeUndefined();
  expect(wrangler.r2_buckets).toBeUndefined();
 });
 it('defines 34 MCP tools',()=>{
  expect(TOOL_NAMES).toHaveLength(34);
  expect(TOOL_NAMES).toContain('fs_archive');
  expect(TOOL_NAMES).toContain('net_probe');
  expect(TOOL_NAMES).toContain('screen_capture');
 });
 it('rejects invalid exec input before dispatch',()=>{
  expect(toolInputSchemas.exec_foreground.safeParse({deviceId:'dev',description:'test',
    command:{mode:'program',program:'node',args:[]}}).success).toBe(true);
  expect(toolInputSchemas.exec_foreground.safeParse({deviceId:'dev',
    command:{mode:'shell',script:'whoami'}}).success).toBe(false);
 });
});
