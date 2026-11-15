import { utf8ByteLength } from '@pertexo/workflow-model';
import type { WorkflowCallIntent } from '@pertexo/workflow-engine';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import type { prepareStoredExecutionValue } from '../../shared/stored-execution.js';

type PreparedCallInput = ReturnType<typeof prepareStoredExecutionValue>;

/** The intent names exactly the attempt output it was planned from. */
export function callInputMatches(
  intent: WorkflowCallIntent,
  attemptId: string,
  prepared: PreparedCallInput,
): boolean {
  if (intent.input.kind === 'inline')
    return (
      intent.input.attemptId === attemptId && prepared.value.kind === 'inline'
    );
  if (intent.input.kind === 'artifact')
    return (
      prepared.value.kind === 'artifact' &&
      intent.input.artifactId === prepared.value.artifactId
    );
  return true;
}

/** A call refuses an input it cannot pass inline. */
export function callInputRefusal(
  prepared: PreparedCallInput,
): string | undefined {
  if (prepared.value.kind === 'artifact') {
    return 'call_input_artifact_unsupported';
  }
  if (
    utf8ByteLength(prepared.json) > STORED_EXECUTION_VALUE_LIMITS.inlineBytes
  ) {
    return 'call_input_too_large';
  }
  return undefined;
}
