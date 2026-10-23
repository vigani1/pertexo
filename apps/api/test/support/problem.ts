import { throwApplicationError } from '../../src/platform/http/application-error.js';
import { toProblem } from '../../src/problems/registry.js';

/** Compose service-level tests with the HTTP projection used in production. */
export function problemResult<T>(
  result: Promise<T>,
  normalize?: (error: unknown) => unknown,
): Promise<T> {
  return result.catch((error: unknown) => {
    return throwApplicationError(
      toProblem(normalize === undefined ? error : normalize(error)),
    );
  });
}
