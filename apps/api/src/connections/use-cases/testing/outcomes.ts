import type { ConnectionTestOutcome } from '@pertexo/database/connections';
import type { SecureHttpError } from '@pertexo/integrations/server';
import { classifySlackConnectionHealth } from '@pertexo/integrations/server';

import type {
  ConnectionEmailClient,
  ConnectionSlackClient,
} from '../../ports.js';

export function slackTestOutcome(
  result: Awaited<ReturnType<ConnectionSlackClient['authTest']>>,
): ConnectionTestOutcome {
  switch (result.kind) {
    case 'succeeded':
      return Object.freeze({ ok: true, httpStatus: 200 });
    case 'rate_limited':
      return Object.freeze({
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      });
    case 'http_failure':
      return Object.freeze({
        ok: false,
        httpStatus: result.status,
        reauthorizationRequired: false,
        errorCode: slackHttpFailureCode(result.status),
      });
    case 'invalid_response':
      return Object.freeze({
        ok: false,
        httpStatus: null,
        errorCode: 'connection.provider_invalid_response',
        reauthorizationRequired: false,
      });
    case 'rejected': {
      const observation = classifySlackConnectionHealth(result);
      const rejected = observation?.kind === 'reauthorization_required';
      return Object.freeze({
        ok: false,
        httpStatus: 200,
        errorCode: rejected
          ? observation.reasonCode
          : 'connection.provider_rejected',
        reauthorizationRequired: rejected,
      });
    }
  }
  throw new TypeError('Unsupported Slack connection-test outcome');
}

export function resendTestOutcome(
  result: Awaited<ReturnType<ConnectionEmailClient['sendNotification']>>,
): ConnectionTestOutcome {
  switch (result.kind) {
    case 'succeeded':
      return Object.freeze({ ok: true, httpStatus: 200 });
    case 'rate_limited':
      return Object.freeze({
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      });
    case 'http_failure':
      return responseOutcome(result.status);
    case 'invalid_response':
      return Object.freeze({
        ok: false,
        httpStatus: null,
        errorCode: 'connection.provider_invalid_response',
        reauthorizationRequired: false,
      });
    case 'rejected':
      return responseOutcome(result.status);
  }
}

export function responseOutcome(status: number): ConnectionTestOutcome {
  if (status >= 200 && status <= 299)
    return Object.freeze({ ok: true, httpStatus: status });
  if (status === 401 || status === 403)
    return Object.freeze({
      ok: false,
      httpStatus: status,
      errorCode: 'connection.credential_rejected',
      reauthorizationRequired: true,
    });
  let errorCode:
    | 'connection.provider_rate_limited'
    | 'connection.provider_unavailable'
    | 'connection.provider_rejected';
  if (status === 429) errorCode = 'connection.provider_rate_limited';
  else if (status >= 500) errorCode = 'connection.provider_unavailable';
  else errorCode = 'connection.provider_rejected';
  return Object.freeze({
    ok: false,
    httpStatus: status,
    errorCode,
    reauthorizationRequired: false,
  });
}

export function secureErrorOutcome(
  error: SecureHttpError,
): ConnectionTestOutcome {
  return Object.freeze({
    ok: false,
    httpStatus: null,
    errorCode: `connection.test.${error.code}`,
    reauthorizationRequired: false,
  });
}

function slackHttpFailureCode(status: number): string {
  if (status === 429) return 'connection.provider_rate_limited';
  return status >= 500
    ? 'connection.provider_unavailable'
    : 'connection.provider_rejected';
}
