import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION } from './constants.js';

const Id = z.string().min(1).max(128);
const IsoDate = z.string().datetime({ offset: true });
const Base = {
  version: z.literal(PROTOCOL_VERSION),
  messageId: Id,
  deviceId: Id,
  connectionEpoch: z.number().int().positive(),
};
const OperationBase = {
  ...Base,
  operationId: Id,
};
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(196_608),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValue).max(10_000),
  z.record(z.string().max(256), JsonValue),
]));

export const ProtocolMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...Base, type: z.literal('device.hello'), payload: z.object({ deviceName: z.string().min(1).max(128), platform: z.string().min(1).max(64), clientVersion: z.string().min(1).max(64), protocolVersion: z.number().int().positive() }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('device.capabilities'), payload: z.object({ capabilities: z.array(z.string().min(1).max(128)).max(256) }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('device.ready'), payload: z.object({ ready: z.literal(true) }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.dispatch'), grantId: Id, actorName: z.string().max(80).optional(), expiresAt: IsoDate, requestHash: z.string().regex(/^[a-f0-9]{64}$/), toolName: z.string().min(1).max(64), input: z.record(z.string(), JsonValue) }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.accepted'), payload: z.object({ acceptedAt: IsoDate }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.started'), payload: z.object({ startedAt: IsoDate }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.result.begin'), payload: z.object({ stdoutBytes: z.number().int().nonnegative().max(LIMITS.operationOutputBytes), stderrBytes: z.number().int().nonnegative().max(LIMITS.operationOutputBytes) }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.result.chunk'), payload: z.object({ stream: z.enum(['stdout', 'stderr']), chunkIndex: z.number().int().nonnegative(), text: z.string().max(LIMITS.resultChunkBytes) }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.result.commit'), payload: z.object({ result: z.record(z.string(), JsonValue), committedAt: IsoDate }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.failed'), payload: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(2_000), retryable: z.boolean(), partialResult: JsonValue.optional() }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('operation.cancelled'), payload: z.object({ reason: z.string().max(512).optional() }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('foreground.cancel'), payload: z.object({ reason: z.string().max(512) }).strict() }).strict(),
  z.object({ ...OperationBase, type: z.literal('control.ack'), payload: z.object({ inReplyTo: Id }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('control.error'), payload: z.object({ inReplyTo: Id.optional(), code: z.string().min(1).max(64), message: z.string().min(1).max(2_000) }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('protocol.unsupported'), payload: z.object({ receivedVersion: z.number().int().positive().optional(), receivedType: z.string().max(64).optional() }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('background.started'), payload: z.object({ backgroundTaskId: Id, pid: z.number().int().positive(), startedAt: IsoDate }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('background.stopped'), payload: z.object({ backgroundTaskId: Id, exitCode: z.number().int().nullable(), stoppedAt: IsoDate }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('transfer.ready'), transferId: Id, payload: z.object({ direction: z.enum(['upload', 'download']), maxChunkBytes: z.number().int().positive().max(LIMITS.binaryChunkBytes), expiresAt: IsoDate }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('transfer.ack'), transferId: Id, payload: z.object({ chunkIndex: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative() }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('transfer.complete'), transferId: Id, payload: z.object({ bytes: z.number().int().nonnegative().max(LIMITS.transferInlineBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('transfer.failed'), transferId: Id, payload: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(2_000) }).strict() }).strict(),
  z.object({ ...Base, type: z.literal('transfer.cancel'), transferId: Id, payload: z.object({ reason: z.string().max(512).optional() }).strict() }).strict(),
]);

export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;

export const BinaryFrameHeaderSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.literal('transfer.chunk'),
  transferId: Id,
  chunkIndex: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  final: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();

export type BinaryFrameHeader = z.infer<typeof BinaryFrameHeaderSchema>;

export function encodeBinaryFrame(headerInput: BinaryFrameHeader, bytes: Uint8Array): ArrayBuffer {
  const header = BinaryFrameHeaderSchema.parse(headerInput);
  if (bytes.byteLength > LIMITS.binaryChunkBytes) throw new RangeError('Binary chunk exceeds protocol limit');
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const totalBytes = 4 + headerBytes.byteLength + bytes.byteLength;
  if (totalBytes > LIMITS.binaryFrameBytes) throw new RangeError('Binary frame exceeds protocol limit');
  const frame = new Uint8Array(totalBytes);
  new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  frame.set(bytes, 4 + headerBytes.byteLength);
  return frame.buffer;
}

export function decodeBinaryFrame(frame: ArrayBuffer | Uint8Array): { header: BinaryFrameHeader; bytes: Uint8Array } {
  const view = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (view.byteLength < 4 || view.byteLength > LIMITS.binaryFrameBytes) throw new RangeError('Invalid binary frame length');
  const headerLength = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, false);
  if (headerLength < 2 || headerLength > 4_096 || 4 + headerLength > view.byteLength) throw new RangeError('Invalid binary frame header length');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(view.subarray(4, 4 + headerLength)));
  } catch {
    throw new TypeError('Invalid binary frame header JSON');
  }
  return {
    header: BinaryFrameHeaderSchema.parse(parsed),
    bytes: view.slice(4 + headerLength),
  };
}
