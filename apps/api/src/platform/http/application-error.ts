import { API_PROBLEM_MANIFEST } from '@pertexo/contracts/errors';
import type { ApiProblemCode } from '@pertexo/contracts/errors';

export const APPLICATION_ERROR_CATALOG = API_PROBLEM_MANIFEST;
export type ApplicationErrorCode = ApiProblemCode;
export type ApplicationErrorCatalogEntry =
  (typeof APPLICATION_ERROR_CATALOG)[ApplicationErrorCode];

export type ApplicationError = Readonly<{
  code: ApplicationErrorCode;
  safeDetail?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}>;

type ApplicationErrorOptions = Readonly<{
  safeDetail?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}>;

export function applicationError(
  code: ApplicationErrorCode,
  options: ApplicationErrorOptions = {},
): ApplicationError {
  const safeDetail = options.safeDetail;
  if (safeDetail !== undefined && safeDetail.length > 2_000) {
    throw new RangeError('safe application error detail is too long');
  }

  return Object.freeze({
    code,
    ...(safeDetail === undefined ? {} : { safeDetail }),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function isApplicationError(value: unknown): value is ApplicationError {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return false;
  }

  const code = value.code;
  return typeof code === 'string' && code in APPLICATION_ERROR_CATALOG;
}

export function throwApplicationError(error: ApplicationError): never {
  // The HTTP problem filter deliberately accepts frozen application-error values.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}
