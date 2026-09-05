import { z } from 'zod';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

export const coordinatorIdentitySchema = z.uuid();
const checksumSchema = sha256HexSchema;
export const coordinatorDeliverySchema = z
  .object({
    outboxEventId: z.uuid(),
    payloadChecksum: checksumSchema,
  })
  .strict();

export type LoadAdvanceStateResult =
  | Readonly<{
      kind:
        | 'not_found'
        | 'not_executable'
        | 'unsupported_checkpoint'
        | 'capacity_exceeded';
    }>
  | Readonly<{
      kind: 'ready';
      state: Readonly<{
        runId: string;
        workflowVersionId: string;
        checkpoint: unknown;
        observations: readonly unknown[];
        completedOutputs?: readonly unknown[];
      }>;
    }>;

export type CommitAdvancePlanResult =
  | Readonly<{
      kind: 'committed';
      revision: number;
      admittedAttempts: readonly Readonly<{
        invocationKey: string;
        nodeRunId: string;
        attemptId: string;
      }>[];
      scheduleToStartSeconds?: number;
    }>
  | Readonly<{
      kind: 'already_committed' | 'deferred' | 'stale';
      revision: number;
    }>
  | Readonly<{ kind: 'not_found' }>;

export type CoordinatorAdvanceDelivery = Readonly<
  z.input<typeof coordinatorDeliverySchema>
>;

export type AcknowledgeAdvanceDeliveryResult = Readonly<{
  kind: 'acknowledged' | 'duplicate';
}>;

export interface CoordinatorRunStore {
  loadAdvanceState(
    input: Readonly<{
      workspaceId: string;
      runId: string;
      signal: AbortSignal;
    }>,
  ): Promise<LoadAdvanceStateResult>;
  commitAdvancePlan(
    input: Readonly<{
      delivery: CoordinatorAdvanceDelivery;
      workspaceId: string;
      runId: string;
      workflowVersionId: string;
      plan: unknown;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ): Promise<CommitAdvancePlanResult>;
  acknowledgeAdvanceDelivery(
    input: Readonly<{
      delivery: CoordinatorAdvanceDelivery;
      workspaceId: string;
      runId: string;
      signal: AbortSignal;
    }>,
  ): Promise<AcknowledgeAdvanceDeliveryResult>;
  close(): Promise<void>;
}

export type LoadAdvanceStateInput = Parameters<
  CoordinatorRunStore['loadAdvanceState']
>[0];
export type CommitAdvancePlanInput = Parameters<
  CoordinatorRunStore['commitAdvancePlan']
>[0];
export type AcknowledgeAdvanceDeliveryInput = Parameters<
  CoordinatorRunStore['acknowledgeAdvanceDelivery']
>[0];

export class CoordinatorPlanInvalidError extends Error {
  public override readonly name = 'CoordinatorPlanInvalidError';
  public constructor() {
    super('Coordinator advance plan is invalid');
  }
}

export class CoordinatorRunStateCorruptError extends Error {
  public override readonly name = 'CoordinatorRunStateCorruptError';
  public constructor() {
    super('Persisted coordinator run state is invalid');
  }
}

export class CoordinatorDeliveryMismatchError extends Error {
  public override readonly name = 'CoordinatorDeliveryMismatchError';
  public constructor() {
    super('Coordinator delivery does not match its durable outbox identity');
  }
}
