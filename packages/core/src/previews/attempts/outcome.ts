import type { CodeDiagnostics } from '@pertexo/node-sdk';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../runs/values/stored-execution.js';
import { canonicalJson } from '@pertexo/workflow-model';
import type { PreviewStatus, PreviewTerminalOutcome } from '../contract.js';
import { PREVIEW_STATUS } from '../state.js';

export type CanonicalCompletionOutcome =
  | Readonly<{
      outputRef: string;
      status: typeof PREVIEW_STATUS.succeeded;
    }>
  | Readonly<{
      safeErrorCode: string;
      errorSummary: string | null;
      status: Exclude<PreviewStatus, 'queued' | 'running' | 'succeeded'>;
    }>;

export function canonicalPreviewOutcome(
  outcome: PreviewTerminalOutcome,
): CanonicalCompletionOutcome {
  return outcome.status === PREVIEW_STATUS.succeeded
    ? ({
        status: PREVIEW_STATUS.succeeded,
        outputRef: serializeStoredExecutionValue(outcome.output),
      } as const)
    : ({
        safeErrorCode: outcome.safeErrorCode,
        errorSummary: outcome.errorSummary ?? null,
        status: outcome.status,
      } as const);
}

/** Only an exact retry of what was stored counts as a duplicate. */
export function sameStoredCompletion(
  row: Readonly<{
    attemptStatus: string;
    runStatus: string;
    attemptOutputRef: unknown;
    runOutputRef: unknown;
    attemptSafeErrorCode: string | null;
    runSafeErrorCode: string | null;
    errorSummary: string | null;
    codeDiagnostics: unknown;
  }>,
  outcome: CanonicalCompletionOutcome,
  diagnostics: CodeDiagnostics | undefined,
): boolean {
  const statusesMatch =
    row.attemptStatus === outcome.status && row.runStatus === outcome.status;
  return (
    statusesMatch &&
    sameStoredValues(row, outcome) &&
    canonicalJson(row.codeDiagnostics) === canonicalJson(diagnostics ?? null)
  );
}

function sameStoredValues(
  row: Parameters<typeof sameStoredCompletion>[0],
  outcome: CanonicalCompletionOutcome,
): boolean {
  if (outcome.status !== PREVIEW_STATUS.succeeded)
    return (
      row.attemptOutputRef === null &&
      row.runOutputRef === null &&
      row.attemptSafeErrorCode === outcome.safeErrorCode &&
      row.runSafeErrorCode === outcome.safeErrorCode &&
      row.errorSummary === outcome.errorSummary
    );
  try {
    return (
      serializeStoredExecutionValue(
        parseStoredExecutionValue(row.attemptOutputRef),
      ) === outcome.outputRef &&
      serializeStoredExecutionValue(
        parseStoredExecutionValue(row.runOutputRef),
      ) === outcome.outputRef &&
      row.attemptSafeErrorCode === null &&
      row.runSafeErrorCode === null
    );
  } catch {
    return false;
  }
}
