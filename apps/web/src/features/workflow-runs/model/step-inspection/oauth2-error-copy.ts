import type { OAuth2StepFailureCode } from '@pertexo/contracts';

import type { StepErrorCopy } from './error-copy';

// Typed by the contract's list, so a new failure code can't reach a person as
// the fallback sentence.

export const connectionRevoked: StepErrorCopy = {
  sentence: 'The connection this step uses was revoked.',
  advice:
    'Choose another connection for this step in Build, publish, then replay the run.',
};

export const OAUTH2_STEP_ERRORS: Readonly<
  Record<OAuth2StepFailureCode, StepErrorCopy>
> = {
  'http.oauth2_not_connected': {
    sentence: 'The connection this step uses isn’t connected.',
    advice: 'Connect it in Connections, then replay the run.',
    fix: 'reconnect',
  },
  'http.oauth2_connection_revoked': connectionRevoked,
  'http.oauth2_grant_revoked': {
    sentence: 'The service no longer accepts this connection’s sign-in.',
    advice: 'Reconnect it in Connections, then replay the run.',
    fix: 'reconnect',
  },
  'http.oauth2_client_rejected': {
    sentence: 'The service refused this connection’s client ID or secret.',
    advice: 'Replace them in Connections, reconnect, then replay the run.',
    fix: 'reconnect',
  },
  'http.oauth2_token_expired': {
    sentence:
      'This connection’s access token expired and the service gave no way to renew it.',
    advice: 'Reconnect it in Connections, then replay the run.',
    fix: 'reconnect',
  },
  'http.oauth2_token_rate_limited': {
    sentence: 'The service’s token address asked Pertexo to slow down.',
    advice:
      'Pertexo waits and retries. If this keeps happening, replay the run later.',
  },
  'http.oauth2_token_endpoint_unavailable': {
    sentence: 'The service’s token address didn’t answer.',
    advice:
      'Pertexo retries on its own while attempts remain. If it keeps failing, replay the run once the service is back.',
  },
  'http.oauth2_token_response_invalid': {
    sentence: 'The service’s token address gave an answer Pertexo can’t use.',
    advice:
      'Check the token URL in Connections. Pertexo retries on its own while attempts remain.',
  },
  'http.oauth2_token_address_blocked': {
    sentence:
      'This connection’s token URL points to a private or blocked address.',
    advice:
      'Change the token URL in Connections, or ask your operator to allow that network, then replay the run.',
  },
  'http.oauth2_refresh_busy': {
    sentence: 'Another step was renewing this connection’s token.',
    advice:
      'Pertexo retries on its own. If it keeps happening, replay the run.',
  },
  'http.oauth2_host_not_allowed': {
    sentence:
      'This connection can’t send its token to the host this step calls.',
    advice:
      'Change the step’s URL in Build or the connection’s allowed hosts in Connections, then replay the run.',
  },
};

export const OAUTH2_SHORT_REASONS: Readonly<
  Record<OAuth2StepFailureCode, string>
> = {
  'http.oauth2_not_connected': 'connection isn’t connected',
  'http.oauth2_connection_revoked': 'connection revoked',
  'http.oauth2_grant_revoked': 'sign-in revoked',
  'http.oauth2_client_rejected': 'client refused',
  'http.oauth2_token_expired': 'token expired',
  'http.oauth2_token_rate_limited': 'rate limited by the service',
  'http.oauth2_token_endpoint_unavailable': 'token address didn’t answer',
  'http.oauth2_token_response_invalid':
    'unusable answer from the token address',
  'http.oauth2_token_address_blocked': 'token URL is blocked',
  'http.oauth2_refresh_busy': 'token renewal was busy',
  'http.oauth2_host_not_allowed': 'host not allowed by the connection',
};
