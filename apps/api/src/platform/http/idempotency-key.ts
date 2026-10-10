import { idempotencyKeySchema } from '@pertexo/contracts';

import {
  applicationError,
  throwApplicationError,
} from './application-error.js';
import { singleRequestHeader, type RequestHeaders } from './request-headers.js';

/**
 * The Idempotency-Key a command requires: exactly one valid value. A missing,
 * repeated or malformed key answers 400.
 */
export function requestIdempotencyKey(headers: RequestHeaders): string {
  const parsed = idempotencyKeySchema.safeParse(
    singleRequestHeader(headers, 'idempotency-key'),
  );
  if (parsed.success) return parsed.data;
  return throwApplicationError(
    applicationError('request.invalid', {
      safeDetail: 'Idempotency-Key must contain exactly one valid value.',
    }),
  );
}
