import { isIntegerInRange } from '../../platform/persisted-primitives.js';
import { FailureNotificationStateError } from '../errors.js';

const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_SECONDS = 3_600;

export function parseFailureNotificationAttemptNumber(value: number): number {
  const invalidAttemptNumber = !isIntegerInRange(
    value,
    1,
    MAX_DELIVERY_ATTEMPTS,
  );
  if (invalidAttemptNumber)
    throw new FailureNotificationStateError('Invalid delivery attempt number');
  return value;
}

export function parseFailureNotificationMaximumAttempts(value: number): number {
  const invalidAttemptLimit = !isIntegerInRange(
    value,
    1,
    MAX_DELIVERY_ATTEMPTS,
  );
  if (invalidAttemptLimit)
    throw new FailureNotificationStateError('Invalid maximum attempts');
  return value;
}

/** Zero is retained for terminal completions where no retry is scheduled. */
export function parseFailureNotificationRetryDelaySeconds(
  value: number,
): number {
  const invalidRetryDelay = !isIntegerInRange(
    value,
    0,
    MAX_RETRY_DELAY_SECONDS,
  );
  if (invalidRetryDelay)
    throw new FailureNotificationStateError('Invalid retry delay');
  return value;
}
