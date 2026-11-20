import { z } from 'zod';

export const pollFailureCodeSchema = z.enum([
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

export type HttpPollFailureCode = z.output<typeof pollFailureCodeSchema>;

export class HttpPollFailure extends Error {
  override readonly name = 'HttpPollFailure';

  constructor(public readonly code: HttpPollFailureCode) {
    super(`HTTP poll failed: ${code}`);
  }
}
