import type { AttemptDiagnosticFields } from '@pertexo/node-sdk';
import { codeCompletionFields } from '../code/diagnostics.js';
import type { NodeExecutionEnvironment } from '../execution/environment.js';

export function completionDiagnosticFields(
  environment: NodeExecutionEnvironment | undefined,
): AttemptDiagnosticFields {
  const guardrailsDiagnostics = environment?.guardrailsDiagnostics();
  if (guardrailsDiagnostics !== undefined) return { guardrailsDiagnostics };
  const modelUsage = environment?.modelUsage();
  return modelUsage === undefined
    ? codeCompletionFields(environment)
    : { modelUsage };
}
