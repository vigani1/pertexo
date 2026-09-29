export type WorkspaceInboxCaptureInput = Readonly<{
  workspaceId: string;
  sourceId: string;
  workerId: string;
  delivery: Readonly<{ outboxEventId: string; payloadChecksum: string }>;
  signal: AbortSignal;
}>;

export type WorkspaceInboxCaptureResult =
  | Readonly<{ kind: 'captured'; audienceCount: string }>
  | Readonly<{
      kind:
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

/** Claim/capture/accounting form one owned operation; no lease escapes to callers. */
export interface WorkspaceInboxCaptureStore {
  capture(
    input: WorkspaceInboxCaptureInput,
  ): Promise<WorkspaceInboxCaptureResult>;
  checkReadiness(signal?: AbortSignal): Promise<void>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}
