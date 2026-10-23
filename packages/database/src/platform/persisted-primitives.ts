import { z } from 'zod';

/** Canonical lowercase SHA-256 hex stored in database digest/checksum columns. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export function isIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
