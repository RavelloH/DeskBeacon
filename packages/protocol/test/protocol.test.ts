import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolMessageSchema,
  decodeBinaryFrame,
  encodeBinaryFrame,
  toolInputSchemas,
} from '../src/index.js';

describe('protocol schemas', () => {
  it('registers the 36 MCP tools with universal batch and paged child output', () => {
    expect(Object.keys(toolInputSchemas)).toHaveLength(36);
  });

  it('round-trips a versioned operation dispatch message', () => {
    const message = {
      version: PROTOCOL_VERSION,
      type: 'operation.dispatch',
      messageId: 'message-1',
      operationId: 'operation-1',
      deviceId: 'device-1',
      connectionEpoch: 3,
      grantId: 'grant-1',
      expiresAt: '2026-10-17T12:00:00.000Z',
      requestHash: 'a'.repeat(64),
      toolName: 'exec_foreground',
      input: { description: 'run a bounded check' },
    };
    expect(ProtocolMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('validates device-initiated rename and server acknowledgment', () => {
    const base = {version:PROTOCOL_VERSION,deviceId:'device-1',connectionEpoch:2,messageId:'rename-1'};
    const rename = {...base,type:'device.rename',payload:{name:'My workstation'}};
    expect(ProtocolMessageSchema.parse(rename)).toEqual(rename);
    expect(ProtocolMessageSchema.safeParse({...rename,payload:{name:'  '}}).success).toBe(false);
    expect(ProtocolMessageSchema.safeParse({...rename,payload:{name:'a'.repeat(129)}}).success).toBe(false);
    expect(ProtocolMessageSchema.safeParse({...rename,payload:{name:'Valid',deviceId:'other'}}).success).toBe(false);
    expect(ProtocolMessageSchema.parse({...base,type:'device.name.updated',payload:{name:'My workstation',inReplyTo:'rename-1'}})).toBeDefined();
    expect(ProtocolMessageSchema.parse({...base,type:'device.ready',payload:{ready:true,deviceName:'My workstation'}})).toBeDefined();
  });

  it('fails closed for unknown versions and message types', () => {
    const message = {
      version: 2,
      type: 'operation.dispatch',
      messageId: 'm',
      operationId: 'o',
      deviceId: 'd',
      connectionEpoch: 1,
    };
    expect(() => ProtocolMessageSchema.parse(message)).toThrow();
    expect(() => ProtocolMessageSchema.parse({ ...message, version: 1, type: 'future.action' })).toThrow();
  });

  it('bounds and round-trips transient binary transfer frames', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const frame = encodeBinaryFrame({
      version: 1,
      type: 'transfer.chunk',
      transferId: 'transfer-1',
      chunkIndex: 0,
      offset: 0,
      final: true,
    }, bytes);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.header.transferId).toBe('transfer-1');
    expect([...decoded.bytes]).toEqual([...bytes]);
    expect(() => encodeBinaryFrame({
      version: 1,
      type: 'transfer.chunk',
      transferId: 'transfer-1',
      chunkIndex: 0,
      offset: 0,
      final: true,
    }, new Uint8Array(LIMITS.binaryChunkBytes + 1))).toThrow(RangeError);
  });

  it('publishes concrete fs_edit MCP parameters and checks mode-specific arguments', () => {
    const output=z.toJSONSchema(toolInputSchemas.fs_edit) as {
      type?:string;properties?:Record<string,unknown>;required?:string[];
    };
    expect(output.type).toBe('object');
    for(const key of ['deviceId','path','mode','oldText','newText','replacements','patch','dryRun','expectedHash'])
      expect(output.properties).toHaveProperty(key);
    expect(output.required).toContain('mode');
    const base={deviceId:'dev',path:'example.ts'};
    expect(toolInputSchemas.fs_edit.safeParse({...base,mode:'replace',oldText:'old',newText:'new'}).success).toBe(true);
    expect(toolInputSchemas.fs_edit.safeParse({...base,mode:'replace_many',replacements:[{oldText:'old',newText:'new'}]}).success).toBe(true);
    expect(toolInputSchemas.fs_edit.safeParse({...base,mode:'patch',patch:'@@ -1 +1 @@\\n-old\\n+new'}).success).toBe(true);
    for(const invalid of [
      {mode:'replace',oldText:'old'}, {mode:'replace',oldText:'old',newText:'new',patch:'bad'},
      {mode:'replace_many',replacements:[]},{mode:'patch',patch:'patch',oldText:'unexpected'},
    ])expect(toolInputSchemas.fs_edit.safeParse({...base,...invalid}).success).toBe(false);
  });

  it('rejects additional fields and oversized inline transfer data', () => {
    expect(() => toolInputSchemas.device_info.parse({ deviceId: 'd', arbitrary: true })).toThrow();
    expect(() => toolInputSchemas.transfer_upload.parse({
      deviceId: 'd',
      description: 'upload text',
      targetPath: 'file.txt',
      dataBase64: 'A'.repeat(LIMITS.transferInlineBase64Chars + 1),
    })).toThrow();
  });
});
