import { PROVIDER_RETRY_FAILURE } from '../../providers/retry-after.errors.js';
import { HTTP_RESPONSE_FAILURES } from './response.errors.js';
import {
  NodeExecutorFailure,
  type ServiceResponseFacts,
} from '@pertexo/node-sdk/server';
import type { HttpOutcomeDecision } from '../outcome-policy.js';
import {
  PROVIDER_HTTP_ERROR_CODE,
  type ProviderHttpErrorCode,
} from '../../providers/http.errors.js';

export class HttpRequestExecutorError extends NodeExecutorFailure {
  public override readonly name = 'HttpRequestExecutorError';
  public override readonly cause: unknown;

  public constructor(
    public readonly decision: HttpOutcomeDecision,
    {
      possiblyDispatched,
      cause,
      serviceResponse,
      responseCode,
    }: Readonly<{
      possiblyDispatched: boolean;
      cause?: unknown;
      serviceResponse?: ServiceResponseFacts;
      responseCode?: ProviderHttpErrorCode;
    }>,
  ) {
    const responseFailure = responseFailureCode(responseCode);
    const retryWaitExceeded =
      decision.kind === 'failed' && decision.reason === 'retry_after_exceeded';
    if (decision.kind === 'succeeded')
      throw new TypeError('Successful HTTP outcome');
    super({
      kind: decision.kind,
      errorKind: decision.errorKind,
      possiblyDispatched,
      ...(decision.kind === 'retry' &&
      decision.minimumRetryDelayMillis !== undefined
        ? { minimumRetryDelayMillis: decision.minimumRetryDelayMillis }
        : {}),
      ...(serviceResponse === undefined ? {} : { serviceResponse }),
      ...(retryWaitExceeded
        ? {
            safeErrorCode: PROVIDER_RETRY_FAILURE.code,
            errorSummary: PROVIDER_RETRY_FAILURE.sentence,
          }
        : {}),
      ...(responseFailure === undefined
        ? {}
        : {
            safeErrorCode: responseFailure,
            errorSummary: HTTP_RESPONSE_FAILURES[responseFailure].sentence,
          }),
    });
    this.cause = cause;
  }
}

function responseFailureCode(code: ProviderHttpErrorCode | undefined) {
  if (code === PROVIDER_HTTP_ERROR_CODE.responseTooLarge)
    return 'http.response_too_large' as const;
  if (code === PROVIDER_HTTP_ERROR_CODE.responseEncodingRejected)
    return 'http.response_encoding' as const;
  if (code === PROVIDER_HTTP_ERROR_CODE.responseRedactionLimit)
    return 'http.response_redaction_limit' as const;
  return undefined;
}
