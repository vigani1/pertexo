import type { WorkflowCheckpoint } from '@pertexo/workflow-engine';
import { z } from 'zod';
import { sha256HexSchema } from '../../validation/persisted-primitives.js';
import type { PublishedWorkflowV2Projection } from '../published-workflow.js';
import type { RunTransitionPlan } from './plan.js';

export const coordinatorIdentitySchema = z.uuid();
export const coordinatorDeliverySchema = z
  .object({
    outboxEventId: z.uuid(),
    payloadChecksum: sha256HexSchema,
  })
  .strict();

export type CoordinatorAdvanceDelivery = Readonly<
  z.input<typeof coordinatorDeliverySchema>
>;

/** Everything the engine needs, read under the run lock. */
export type RunAdvanceState = Readonly<{
  runId: string;
  workflowVersionId: string;
  /** Stored checkpoint JSON; the engine parses it. */
  checkpoint: unknown;
  observations: readonly unknown[];
  completedOutputs: readonly unknown[];
  workflow: PublishedWorkflowV2Projection;
}>;

export type RunAdvanceDecision =
  | Readonly<{ kind: 'no_change' }>
  | Readonly<{
      kind: 'transition';
      /** The stored checkpoint as the engine parsed it. */
      previous: WorkflowCheckpoint;
      plan: RunTransitionPlan;
    }>;

export type RunAdvanceInput = Readonly<{
  delivery: CoordinatorAdvanceDelivery;
  workspaceId: string;
  runId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;

export type RunAdvanceResult =
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
      kind: 'already_committed' | 'deferred' | 'no_change';
      revision: number;
    }>
  | Readonly<{
      kind: 'not_found' | 'not_executable' | 'capacity_exceeded';
    }>;

export interface RunAdvanceStore {
  /**
   * Locks the run, reads its state, lets `decide` compute the transition and
   * saves it, all in one transaction.
   */
  advance(
    input: RunAdvanceInput,
    decide: (state: RunAdvanceState) => Promise<RunAdvanceDecision>,
  ): Promise<RunAdvanceResult>;
  close(): Promise<void>;
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
