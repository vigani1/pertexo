import type { WorkspaceInboxCaptureInput } from './capture-contract.js';

export type WorkspaceInboxProjectionInput = WorkspaceInboxCaptureInput;

export type WorkspaceInboxProjectionResult =
  | Readonly<{
      kind: 'projected';
      processedCount: number;
      insertedCount: number;
      skippedCount: number;
      hasMore: boolean;
    }>
  | Readonly<{
      kind:
        | 'completed'
        | 'not_captured'
        | 'unavailable'
        | 'inactive'
        | 'expired'
        | 'blocked'
        | 'busy'
        | 'not_due'
        | 'lost_ownership'
        | 'retry_scheduled'
        | 'outcome_unknown';
    }>;

/** One owned, bounded page. No lease/cursor/accounting authority escapes. */
export interface WorkspaceInboxProjectionStore {
  projectNextPage(
    input: WorkspaceInboxProjectionInput,
  ): Promise<WorkspaceInboxProjectionResult>;
  checkReadiness(signal?: AbortSignal): Promise<void>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}
