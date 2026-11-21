import { attemptDiagnosticFields } from '@pertexo/node-sdk';
import { decodeStoredValue } from '../../shared/stored-values.js';
import type {
  PreviewReplayRecord,
  ResolvePreviewReplayInput,
} from './preview-replay.types.js';

import type { Role } from '@pertexo/policy';
import { parseStoredExecutionValue } from '../../shared/stored-execution.js';

import { PreviewAcceptanceCorruptError } from '../preview.errors.js';
import { previewWorkflowVisible } from './acceptance/admission.repository.js';
import { readExistingAcceptance } from './acceptance/replay.js';

import { readLivePreviewReplay } from './preview-runs.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

export async function resolvePreviewReplay(
  transaction: WorkspaceTransaction,
  input: ResolvePreviewReplayInput,
  role: Role,
  now: Date = new Date(),
): Promise<PreviewReplayRecord | null> {
  if (
    !(await previewWorkflowVisible(
      transaction,
      role,
      input.actorUserId,
      input.workflowId,
    ))
  )
    return null;
  const existing = await readExistingAcceptance(transaction, {
    keyHash: input.keyHash,
    operation: 'preview.execute',
    requestHash: input.requestHash,
    scope: `${input.actorUserId}:${input.workflowId}`,
  });
  if (existing === null) return null;
  const replay = await readLivePreviewReplay(
    transaction,
    existing.previewRunId,
    now,
  );
  if (replay === undefined) return null;
  if (replay.workflowId !== input.workflowId)
    throw new PreviewAcceptanceCorruptError();
  const { outputRef, pinnedSampleId, diagnostics, errorSummary, ...summary } =
    replay;
  return Object.freeze({
    ...summary,
    ...(errorSummary === null ? {} : { errorSummary }),
    ...attemptDiagnosticFields(diagnostics),
    ...(pinnedSampleId === null ? {} : { pinnedSampleId }),
    output:
      outputRef === null
        ? null
        : decodeStoredValue(() => parseStoredExecutionValue(outputRef)),
  });
}
