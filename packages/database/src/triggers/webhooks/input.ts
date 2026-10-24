import { z } from 'zod';

export const SIGNATURE_CHECKS = [
  'verified',
  'mismatch',
  'not_checked',
] as const;

export const REPLAY_CHECKS = [
  'new',
  'duplicate',
  'conflict',
  'stale_timestamp',
  'not_checked',
] as const;

export const uuidSchema = z.uuid();

export const bodyBytesSchema = z
  .number()
  .int()
  .min(0)
  .max(256 * 1024);

export const pageLimitSchema = z.number().int().positive().max(100);

const receivedAtSchema = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });

export const positionSchema = z
  .object({ receivedAt: receivedAtSchema, id: uuidSchema })
  .strict();

export const rejectedOutcomeSchema = z.enum([
  'authentication_failed',
  'invalid_request',
  'conflict',
  'rate_limited',
  'paused',
]);
