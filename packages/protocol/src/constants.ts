export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  controlFrameBytes: 256 * 1024,
  binaryFrameBytes: 128 * 1024,
  binaryChunkBytes: 64 * 1024,
  resultChunkBytes: 128 * 1024,
  resultPreviewBytes: 16 * 1024,
  operationOutputBytes: 16 * 1024 * 1024,
  deviceHistoryBytes: 64 * 1024 * 1024,
  transferInlineBytes: 128 * 1024,
  transferInlineBase64Chars: 4 * Math.ceil((128 * 1024) / 3),
  operationTtlMs: 24 * 60 * 60 * 1000,
  maxForegroundTimeoutMs: 300_000,
  defaultForegroundTimeoutMs: 120_000,
  // Tolerate transient outages while the client retries on its fixed one-second schedule.
  shortDisconnectGraceMs: 60_000,
  // A queued command may be behind one foreground call lasting the full 300s maximum.
  queueTtlMs: 330_000,
} as const;

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'INVALID_INPUT',
  'DEVICE_NOT_FOUND',
  'DEVICE_OFFLINE',
  'DEVICE_DISCONNECTED',
  'QUEUE_TIMEOUT',
  'OPERATION_TIMEOUT',
  'OPERATION_UNKNOWN',
  'DUPLICATE_OPERATION',
  'OUTPUT_LIMIT',
  'RESULT_INVALID',
  'PROTOCOL_UNSUPPORTED',
  'UNSUPPORTED_HOST_TRANSFER',
  'TRANSFER_LIMIT',
  'TRANSFER_INCOMPLETE',
  'CANCELLED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
