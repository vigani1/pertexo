import { z } from 'zod';

import { POSTGRES_FAILURE_CODES } from './postgres.errors.js';

const httpPollFailureCodeSchema = z.enum([
  'http.poll_invalid_page',
  'http.poll_invalid_items',
  'http.poll_invalid_key',
  'http.poll_navigation_denied',
  'http.poll_authentication',
  'http.poll_rate_limited',
  'http.poll_deadline_exceeded',
  'http.poll_response_failed',
  'http.poll_request_failed',
]);

export type HttpPollFailureCode = z.output<typeof httpPollFailureCodeSchema>;

export const pollFailureCodeSchema = z.enum([
  ...httpPollFailureCodeSchema.options,
  ...POSTGRES_FAILURE_CODES.map((code) => `database.${code}` as const),
  'database.poll_invalid_key',
  'database.poll_rate_limited',
]);

export type PollFailureCode = z.output<typeof pollFailureCodeSchema>;

export function isPollAuthenticationFailure(
  code: PollFailureCode | null,
): boolean {
  return (
    code === 'http.poll_authentication' ||
    code === 'database.authentication_failed'
  );
}

export class PollFailure extends Error {
  constructor(public readonly code: PollFailureCode) {
    super(`Poll failed: ${code}`);
    this.name = 'PollFailure';
  }
}

export class HttpPollFailure extends PollFailure {
  declare readonly code: HttpPollFailureCode;

  constructor(code: HttpPollFailureCode) {
    super(code);
    this.name = 'HttpPollFailure';
  }
}
