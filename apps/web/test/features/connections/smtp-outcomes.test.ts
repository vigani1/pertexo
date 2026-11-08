import { expect, it } from 'vitest';
import { describeTestOutcome } from '@/features/connections/model/connection-health';

it.each([
  ['connection.smtp_network', 'Cannot connect.'],
  ['connection.smtp_tls', 'TLS failed.'],
  ['connection.smtp_authentication', 'Authentication failed.'],
  ['connection.smtp_sender_rejected', 'Sender refused.'],
])('explains %s with safe, specific guidance', (errorCode, title) => {
  const result = describeTestOutcome(
    'email',
    { ok: false, httpStatus: null, errorCode },
    'smtp',
  );
  expect(result.title).toBe(title);
  expect(result.detail).not.toBe('');
});
