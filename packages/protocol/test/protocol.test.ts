import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolMessageSchema,
  decodeBinaryFrame,
  encodeBinaryFrame,
  toolInputSchemas,
} from '../src/index.js';

describe('protocol schemas', () => {
  it('registers the 35 MCP tools with only universal batch', () => {
    expect(Object.keys(toolInputSchemas)).toHaveLength(35);
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
