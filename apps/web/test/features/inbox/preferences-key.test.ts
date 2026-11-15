import { expect, it } from 'vitest';
import {
  inboxKeys,
  isNotificationPreferencesKey,
} from '@/features/inbox/data/inbox-keys';

it('finds every cached email schedule, whoever and wherever it belongs to', () => {
  expect(isNotificationPreferencesKey(inboxKeys.preferences('u1', 'w1'))).toBe(
    true,
  );
  expect(isNotificationPreferencesKey(inboxKeys.preferences('u2', 'w9'))).toBe(
    true,
  );
});

it('leaves the inbox’s other reads alone', () => {
  expect(isNotificationPreferencesKey(inboxKeys.summary('u1', 'w1'))).toBe(
    false,
  );
  expect(isNotificationPreferencesKey(inboxKeys.scope('u1', 'w1'))).toBe(false);
  expect(
    isNotificationPreferencesKey([
      ...inboxKeys.scope('u1', 'w1'),
      'subscription',
      'workflow',
      'x',
    ]),
  ).toBe(false);
});
