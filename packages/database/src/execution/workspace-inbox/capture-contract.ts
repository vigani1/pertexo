import { z } from 'zod';

export const workspaceInboxDeliveryInputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceId: z.uuid(),
    workerId: z.string().min(1).max(128),
    delivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

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
