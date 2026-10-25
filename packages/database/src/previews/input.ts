import { z } from 'zod';

export const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

export function optionsFor(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}
