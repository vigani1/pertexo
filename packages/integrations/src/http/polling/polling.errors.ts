import { HttpPollFailure } from '@pertexo/workflow-model';
import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { OAuth2TokenFailure } from '../../oauth2/oauth2.errors.js';
import { inspectProviderHttpError } from '../../providers/http.errors.js';
import { HttpPaginationFailure } from '../request/pagination/pagination.errors.js';
import { HttpRequestExecutorError } from '../request/request.errors.js';

export {
  HttpPollFailure,
  type HttpPollFailureCode,
} from '@pertexo/workflow-model';

export function pollFailure(error: unknown): HttpPollFailure {
  if (error instanceof HttpPollFailure) return error;
  if (error instanceof HttpPaginationFailure)
    return new HttpPollFailure(
      error.code === 'http.pagination_invalid_page'
        ? 'http.poll_invalid_page'
        : 'http.poll_navigation_denied',
    );
  if (error instanceof OAuth2TokenFailure)
    return new HttpPollFailure(oauthPollFailureCode(error));

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

function oauthPollFailureCode({
  code,
}: OAuth2TokenFailure): HttpPollFailure['code'] {
  switch (code) {
    case 'http.oauth2_not_connected':
    case 'http.oauth2_connection_revoked':
    case 'http.oauth2_grant_revoked':
    case 'http.oauth2_client_rejected':
    case 'http.oauth2_token_expired':
      return 'http.poll_authentication';
    case 'http.oauth2_host_not_allowed':
    case 'http.oauth2_token_address_blocked':
      return 'http.poll_navigation_denied';
    case 'http.oauth2_token_rate_limited':
      return 'http.poll_rate_limited';
    case 'http.oauth2_refresh_busy':
    case 'http.oauth2_token_endpoint_unavailable':
    case 'http.oauth2_token_response_invalid':
      return 'http.poll_request_failed';
  }
}
