import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { OAuth2TokenFailure } from '../../oauth2/oauth2.errors.js';
import { inspectProviderHttpError } from '../../providers/http.errors.js';
import { HttpPaginationFailure } from '../request/pagination/pagination.errors.js';
import { HttpRequestExecutorError } from '../request/request.errors.js';

export type HttpPollFailureCode =
  | 'http.poll_invalid_page'
  | 'http.poll_invalid_items'
  | 'http.poll_invalid_key'
  | 'http.poll_navigation_denied'
  | 'http.poll_authentication'
  | 'http.poll_rate_limited'
  | 'http.poll_deadline_exceeded'
  | 'http.poll_response_failed'
  | 'http.poll_request_failed'
  | OAuth2TokenFailure['code'];

export class HttpPollFailure extends Error {
  override readonly name = 'HttpPollFailure';

  constructor(public readonly code: HttpPollFailureCode) {
    super(`HTTP poll failed: ${code}`);
  }
}

export function pollFailure(error: unknown): HttpPollFailure {
  if (error instanceof HttpPollFailure) return error;
  if (error instanceof HttpPaginationFailure)
    return new HttpPollFailure(
      error.code === 'http.pagination_invalid_page'
        ? 'http.poll_invalid_page'
        : 'http.poll_navigation_denied',
    );
  if (error instanceof OAuth2TokenFailure)
    return new HttpPollFailure(error.code);
  if (error instanceof ProviderExecutionRateLimitError)
    return new HttpPollFailure('http.poll_rate_limited');
  if (
    error instanceof ProviderCredentialInvalidError ||
    error instanceof HttpRequestExecutorError
  )
    return new HttpPollFailure('http.poll_authentication');
  const code = inspectProviderHttpError(error)?.code;
  if (
    code === 'ssrf_blocked' ||
    code === 'redirect_rejected' ||
    code === 'invalid_request'
  )
    return new HttpPollFailure('http.poll_navigation_denied');
  if (code === 'connection_fence_failed')
    return new HttpPollFailure('http.poll_authentication');
  if (code === 'timed_out')
    return new HttpPollFailure('http.poll_deadline_exceeded');
  return new HttpPollFailure('http.poll_request_failed');
}
