import {
  isAuthenticExecutableIdentity,
  type CompiledWorkflowExecutableV2,
} from './executable-foundation.js';
import {
  isAuthenticExecutableIdentityV3,
  type CompiledWorkflowExecutableV3,
} from './executable-v3.js';
import { WorkflowEngineError } from '../errors.js';

export type CompiledWorkflowExecutable =
  CompiledWorkflowExecutableV2 | CompiledWorkflowExecutableV3;

/** Authenticate before reading any caller-supplied envelope or discriminator. */
export function assertAuthenticWorkflowExecutable(
  value: unknown,
): asserts value is CompiledWorkflowExecutable {
  if (
    !isAuthenticExecutableIdentity(value) &&
    !isAuthenticExecutableIdentityV3(value)
  )
    throw new WorkflowEngineError(
      'executable_invalid',
      'workflow executable identity was not verified in this process',
    );
}
