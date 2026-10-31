import type { OAuth2StepFailureCode } from '@pertexo/contracts';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

import type { OAuth2TokenFailure } from '../../oauth2/contract.js';

type Outcome = Readonly<{
  kind: 'failed' | 'retry';
  errorKind: 'authentication' | 'configuration' | 'provider' | 'rate_limit';
  summary: string;
}>;

const outcomes: Readonly<Record<OAuth2StepFailureCode, Outcome>> =
  Object.freeze({
    'http.oauth2_not_connected': {
      kind: 'failed',
      errorKind: 'authentication',
      summary: "This connection isn't connected. Reconnect it in Connections.",
    },
    'http.oauth2_grant_revoked': {
      kind: 'failed',
      errorKind: 'authentication',
      summary:
        "The service no longer accepts this connection's sign-in. Reconnect it in Connections.",
    },
    'http.oauth2_client_rejected': {
      kind: 'failed',
      errorKind: 'authentication',
      summary:
        'The service refused the client ID or secret. Replace them in Connections, then reconnect.',
    },
    'http.oauth2_token_expired': {
      kind: 'failed',
      errorKind: 'authentication',
      summary:
        'The access token expired and the service gave no way to renew it. Reconnect it in Connections.',
    },
    'http.oauth2_token_rate_limited': {
      kind: 'retry',
      errorKind: 'rate_limit',
      summary: "The service's token address asked Pertexo to slow down.",
    },
    'http.oauth2_token_endpoint_unavailable': {
      kind: 'retry',
      errorKind: 'provider',
      summary: "The service's token address didn't answer.",
    },
    'http.oauth2_token_response_invalid': {
      kind: 'retry',
      errorKind: 'provider',
      summary:
        "The service's token address gave an answer Pertexo can't use. Check the token URL.",
    },
    'http.oauth2_token_address_blocked': {
      kind: 'failed',
      errorKind: 'configuration',
      summary: 'The token URL points to a private or blocked address.',
    },
    'http.oauth2_refresh_busy': {
      kind: 'retry',
      errorKind: 'provider',
      summary: "Another step is renewing this connection's token.",
    },
    'http.oauth2_host_not_allowed': {
      kind: 'failed',
      errorKind: 'configuration',
      summary:
        "This connection can't send its token to that host. Change the URL or the connection's allowed hosts.",
    },
  });

/** Every failure here came before the service's API was called. */
export class HttpOAuth2Failure extends NodeExecutorFailure {
  public override readonly name = 'HttpOAuth2Failure';
  public constructor(failure: OAuth2TokenFailure) {
    const outcome = outcomes[failure.code];
    super({
      kind: outcome.kind,
      errorKind: outcome.errorKind,
      possiblyDispatched: false,
      safeErrorCode: failure.code,
      errorSummary: outcome.summary,
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { minimumRetryDelayMillis: failure.retryAfterSeconds * 1_000 }),
    });
  }
}
