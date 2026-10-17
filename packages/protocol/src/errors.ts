import { z } from 'zod';
import { ERROR_CODES } from './constants.js';

export const StructuredErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  operationId: z.string().min(1).max(128).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  partialResult: z.unknown().optional(),
});

export type StructuredError = z.infer<typeof StructuredErrorSchema>;

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
