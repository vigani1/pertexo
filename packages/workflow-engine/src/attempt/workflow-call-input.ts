import {
  NodeExecutorFailure,
  type NodeExecutionResult,
} from '@pertexo/node-sdk/server';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import { workflowCallPinSchemaV1 } from '@pertexo/workflow-model/workflow-call-contract';
import { isAuthenticExecutableIdentityV3 } from '../compilation/executable-v3.js';
import type { WorkflowExecutableNodeV2 } from '../executable-workflow.js';
import { operationError } from '../operation-values.js';
import { validateWorkflowCallInputV1 } from '../workflow-call-values.js';
import type { ExecuteNodeAttemptInput } from './node-attempt-contract.js';
import { normalizeBoundedEngineJson } from '../executable-workflow.js';

/** Validate actual mapped input before the pure declaration executor can succeed. */
export function validateCallDeclarationAttemptInput(
  input: ExecuteNodeAttemptInput,
  node: WorkflowExecutableNodeV2,
  value: JsonValue,
): JsonValue {
  if (node.definition.key !== 'core.workflow_call') return value;
  if (
    !isAuthenticExecutableIdentityV3(input.executable) ||
    node.definition.version !== 1
  )
    operationError(
      'attempt_invalid',
      'Call declaration requires executable V3',
    );
  const pin = workflowCallPinSchemaV1.parse(node.config);
  const declaration = input.calleeDeclarations?.get(pin.versionId);
  if (declaration === undefined)
    operationError('attempt_invalid', 'retained callee declaration is missing');
  const validated = validateWorkflowCallInputV1({ pin, declaration, value });
  if (!validated.ok)
    throw new NodeExecutorFailure({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
  return validated.value;
}

/** A pure declaration must retain its actual input, never manufacture a child result or timer. */
export function validateCallDeclarationAttemptResult(
  node: WorkflowExecutableNodeV2,
  input: JsonValue,
  result: NodeExecutionResult,
): NodeExecutionResult {
  if (node.definition.key !== 'core.workflow_call') return result;
  if (result.kind !== 'succeeded')
    operationError(
      'attempt_invalid',
      'Call declaration requires an ordinary succeeded result',
    );
  let output: JsonValue;
  try {
    output = normalizeBoundedEngineJson(result.output);
  } catch {
    operationError('attempt_invalid', 'Call declaration output is invalid');
  }
  if (canonicalJson(output) !== canonicalJson(input))
    operationError(
      'attempt_invalid',
      'Call declaration output does not match its input',
    );
  return { kind: 'succeeded', output };
}
