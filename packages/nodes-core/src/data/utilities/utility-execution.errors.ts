import { attemptStepRefusal } from '../../catalog/inline-registration.js';
import { CoreStepRefusal } from '../../catalog/core-step.errors.js';
import { UTILITY_ERROR_CODE } from './utility-result.js';

export function refuseUtility(
  code: keyof typeof UTILITY_ERROR_CODE,
  summary: string,
): never {
  throw attemptStepRefusal(
    new CoreStepRefusal(UTILITY_ERROR_CODE[code], summary),
  );
}
