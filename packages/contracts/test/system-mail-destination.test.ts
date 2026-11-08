import { describe, expect, it } from 'vitest';
import {
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
} from '../src/index.js';

const memberId = '11111111-1111-4111-8111-111111111111';
describe('server-mail failure alert contract', () => {
  it('addresses exactly one member without a connection or free-form address', () => {
    expect(
      failureNotificationDestinationCreateRequestSchema.parse({
        kind: 'system_mail',
        memberId,
      }),
    ).toEqual({ kind: 'system_mail', memberId });
    expect(
      failureNotificationDestinationCreateRequestSchema.safeParse({
        kind: 'system_mail',
        toEmail: 'outsider@example.test',
      }).success,
    ).toBe(false);
    expect(
      failureNotificationDestinationCreateRequestSchema.safeParse({
        kind: 'system_mail',
        memberId,
        toEmail: 'outsider@example.test',
      }).success,
    ).toBe(false);
  });
  it('explains when server mail is unavailable', () => {
    const result = failureNotificationDestinationListResponseSchema.parse({
      items: [],
      systemMail: {
        available: false,
        reason: 'This server has no system mail configured.',
      },
    });
    expect(result).toMatchObject({
      systemMail: {
        available: false,
        reason: 'This server has no system mail configured.',
      },
    });
  });
});
