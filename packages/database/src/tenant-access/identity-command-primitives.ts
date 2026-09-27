import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Retained printable key contract for member, profile and rename receipts. */
export const commandKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);

export const commandRevisionSchema = z.number().int().positive();

/** Retained flat member/profile/rename receipt encoding; nested values are unsupported. */
export function hashFlatIdentityCommand(
  input: Readonly<Record<string, string | number | boolean | null>>,
): string {
  for (const value of Object.values(input)) {
    if (
      value !== null &&
      !['string', 'number', 'boolean'].includes(typeof value)
    )
      throw new TypeError('Flat identity command contains a nested value');
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError('Flat identity command contains a non-finite number');
  }
  return createHash('sha256')
    .update(JSON.stringify(input, Object.keys(input).sort()))
    .digest('hex');
}

export function hashIdentityCommandKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
