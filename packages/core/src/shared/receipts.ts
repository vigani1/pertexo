import { IdempotencyConflictError } from '@pertexo/database/platform';
import type { z } from 'zod';

/**
 * A replay answers from stored JSON. One that no longer reads can't be answered,
 * and running the command again could repeat it, so the key is refused: the
 * caller gets a conflict and a new key, not an invalid date or a crash.
 */
export function requireReadableReceipt(
  shape: z.ZodType,
  stored: unknown,
): void {
  if (!shape.safeParse(stored).success) throw new IdempotencyConflictError();
}

/**
 * Decode command output where persisted JSON enters the application. An unreadable
 * receipt is a request-key conflict (409) in every area, never a replayed success.
 */
export function decodeStoredReceipt<T>(
  shape: z.ZodType<T>,
  stored: unknown,
): T {
  const decoded = shape.safeParse(stored);
  if (!decoded.success) throw new IdempotencyConflictError();
  return decoded.data;
}
