import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { captureWorkspaceVariableRevision } from '../../../variables/head.repository.js';
import { RunVariableSnapshotUnavailableError } from './run-admission.errors.js';
import { shareReplayVariableRevision } from './variable-sources.repository.js';

/** Replay precedes inheritance; neither may silently fall back to mutable workspace values. */
export async function variableRevisionForAcceptance(
  transaction: WorkspaceTransaction,
  sourceRunId: string | undefined,
  inherited?: number | null,
): Promise<number | null> {
  if (sourceRunId !== undefined) {
    const source = await shareReplayVariableRevision(transaction, sourceRunId);
    if (!source?.retained) throw new RunVariableSnapshotUnavailableError();
    return source.revision;
  }
  return inherited === undefined
    ? captureWorkspaceVariableRevision(transaction)
    : inherited;
}
