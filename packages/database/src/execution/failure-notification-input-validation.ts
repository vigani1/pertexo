import { FailureNotificationStateError } from './failure-notification-errors.js';

const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_SECONDS = 3_600;

export function parseFailureNotificationAttemptNumber(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DELIVERY_ATTEMPTS
  )
    throw new FailureNotificationStateError('Invalid delivery attempt number');
  return value;
}

export function parseFailureNotificationMaximumAttempts(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DELIVERY_ATTEMPTS
  )
    throw new FailureNotificationStateError('Invalid maximum attempts');
  return value;
}

/** Zero is retained for terminal completions where no retry is scheduled. */
export function parseFailureNotificationRetryDelaySeconds(
  value: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_RETRY_DELAY_SECONDS
  )
    throw new FailureNotificationStateError('Invalid retry delay');
  return value;
}
