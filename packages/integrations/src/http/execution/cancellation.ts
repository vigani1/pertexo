import type { SecureHttpError } from '../secure-error.js';
import {
  SECURE_HTTP_ERROR_CODE,
  type SecureHttpErrorCode,
  failure,
  abortFailure,
  isTimeoutError,
} from '../secure-error.js';

import { normalizeUnknownError } from '../unknown-error.js';
import type {
  SecureHttpFailureStage,
  DispatchFailureContext,
} from './contract.js';

export function failureStage(
  code: SecureHttpErrorCode,
): SecureHttpFailureStage {
  switch (code) {
    case SECURE_HTTP_ERROR_CODE.invalidRequest:
    case SECURE_HTTP_ERROR_CODE.ssrfBlocked:
      return 'admission';
    case SECURE_HTTP_ERROR_CODE.canceled:
    case SECURE_HTTP_ERROR_CODE.timedOut:
      return 'cancellation';
    case SECURE_HTTP_ERROR_CODE.dnsFailed:
      return 'dns';
    case SECURE_HTTP_ERROR_CODE.connectionFenceFailed:
    case SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch:
    case SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed:
      return 'pre_dispatch';
    case SECURE_HTTP_ERROR_CODE.paginationOriginChanged:
    case SECURE_HTTP_ERROR_CODE.redirectRejected:
      return 'redirect';
    case SECURE_HTTP_ERROR_CODE.paginationNavigationInvalid:
    case SECURE_HTTP_ERROR_CODE.responseEncodingRejected:
    case SECURE_HTTP_ERROR_CODE.responseTooLarge:
      return 'response';
    case SECURE_HTTP_ERROR_CODE.networkFailed:
      return 'transport';
  }
}

export function assertNotAborted(
  signal: AbortSignal | undefined,
  failureContext: DispatchFailureContext,
): void {
  if (signal?.aborted === true)
    throw abortFailure(
      signal,
      failureContext.possiblyDispatched,
      failureContext.ambiguous,
    );
}

export function mapTransportError(
  error: unknown,
  signal: AbortSignal | undefined,
): SecureHttpError {
  if (signal?.aborted === true) return abortFailure(signal, true, true);
  if (isTimeoutError(error))
    return failure(SECURE_HTTP_ERROR_CODE.timedOut, true, true, error);
  return failure(SECURE_HTTP_ERROR_CODE.networkFailed, true, true, error);
}

export function raceWithSignal<T>(
  work: Promise<T>,
  signal: AbortSignal,
  failureContext: DispatchFailureContext,
  disposeLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', aborted);
      complete();
      return true;
    };
    const aborted = (): void => {
      settle(() => {
        reject(
          abortFailure(
            signal,
            failureContext.possiblyDispatched,
            failureContext.ambiguous,
          ),
        );
      });
    };
    void work.then(
      (value) => {
        if (
          !settle(() => {
            resolve(value);
          })
        ) {
          try {
            disposeLateValue?.(value);
          } catch {
            // The selected cancellation remains authoritative over disposal.
          }
        }
      },
      (error: unknown) => {
        settle(() => {
          reject(normalizeUnknownError(error, 'Secure HTTP operation failed'));
        });
      },
    );
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
