import { z } from 'zod';

export const StructuredErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  operationId: z.string().min(1).max(128).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  partialResult: z.unknown().optional(),
});

export type StructuredError = z.infer<typeof StructuredErrorSchema>;

/** Preserve actionable tool failures across the device, batch and MCP boundaries. */
export function normalizeToolError(error: unknown): {
  code: string; message: string; retryable: boolean; partialResult?: unknown
} {
  const object = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const explicit = typeof object.code === 'string' ? object.code : undefined;
  const prefix = /^([A-Z][A-Z0-9_]{2,63})(?::|\b)/.exec(message)?.[1];
  const code = explicit && /^[A-Z][A-Z0-9_]{2,63}$/.test(explicit) ? explicit
    : prefix ?? 'TOOL_EXCEPTION';
  return {code, message, retryable:code==='EAGAIN'||code==='ETIMEDOUT'||code==='EBUSY',
    ...(object.partialResult!==undefined?{partialResult:object.partialResult}:{})};
}

export class DeskBeaconError extends Error {
  readonly code: StructuredError['code'];
  readonly retryable: boolean;
  readonly operationId: string | undefined;
  readonly deviceId: string | undefined;
  readonly partialResult?: unknown;

  constructor(error: StructuredError) {
    super(error.message);
    this.name = 'DeskBeaconError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.operationId = error.operationId;
    this.deviceId = error.deviceId;
    this.partialResult = error.partialResult;
  }

  toJSON(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.operationId ? { operationId: this.operationId } : {}),
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      ...(this.partialResult !== undefined ? { partialResult: this.partialResult } : {}),
    };
  }
}
