import { expect, it } from 'vitest';
import {
  canResend,
  newCommandKey,
  COMMAND_RETRY_WINDOW_MS,
} from '@/lib/api/commands/command-retry';
it('timestamps keys and stops retrying across the receipt retention boundary', () => {
  let instant = 1000;
  const now = () => instant;
  const key = newCommandKey(now);
  expect(key.createdAt).toBe(1000);
  instant = key.createdAt + COMMAND_RETRY_WINDOW_MS - 1;
  expect(canResend(key, now)).toBe(true);
  instant += 2;
  expect(canResend(key, now)).toBe(false);
});
