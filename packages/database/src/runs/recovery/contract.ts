import type {
  JsonValue,
  WorkflowRecoveryEffectRisk,
} from '@pertexo/workflow-model';
import type {
  RecoveryCopy,
  RecoveryNode,
  RecoveryRefused,
  RecoveryValues,
} from '@pertexo/workflow-engine';
import type { PublishedWorkflow } from '../queries/execution/published.queries.js';
import type { WorkflowRunRecord } from '../commands/records.repository.js';

export type WorkflowRecoverySummary = Readonly<{
  targetNodeRunId: string;
  targetNodeId: string;
  reusedCount: number;
  effectRisk: WorkflowRecoveryEffectRisk;
  effectsAcknowledged: boolean;
}>;

export class WorkflowRecoveryUnavailableError extends Error {
  public override readonly name = 'WorkflowRecoveryUnavailableError';
  public constructor(public readonly reason: RecoveryRefused['reason']) {
    super('run.recovery_unavailable');
  }
}

export type WorkflowRecoveryPreview =
  | RecoveryRefused
  | Readonly<{
      kind: 'eligible';
      workflowVersionId: string;
      versionNumber: number;
      nodeRunId: string;
      nodeId: string;
      nodeLabel: string | null;
      reusedCount: number;
      sourceCompletedAt: string;
      effectRisk: WorkflowRecoveryEffectRisk;
    }>;

export interface WorkflowRecoveryMetadata {
  readonly run: WorkflowRunRecord;
  readonly workflow: PublishedWorkflow;
  readonly checkpoint: unknown;
  readonly nodes: readonly RecoveryNode[];
  readonly failedStep:
    Readonly<{ nodeId: string; label: string | null }> | undefined;
}

export type PreparedWorkflowRecovery = Readonly<{
  kind: 'eligible';
  preview: Exclude<WorkflowRecoveryPreview, RecoveryRefused>;
  input: JsonValue | undefined;
  seed(
    identity: Readonly<{
      runId: string;
      nodeRunIds: ReadonlyMap<string, string>;
    }>,
  ):
    | RecoveryRefused
    | Readonly<{
        kind: 'seeded';
        checkpoint: unknown;
        copies: readonly RecoveryCopy[];
      }>;
}>;

/** Execution selects metadata first; storage then loads only those owned values. */
export type WorkflowRecoveryPreparation = (
  metadata: WorkflowRecoveryMetadata,
) =>
  | RecoveryRefused
  | Readonly<{
      kind: 'candidate';
      nodeRunIds: readonly string[];
      complete(
        values: RecoveryValues,
      ): RecoveryRefused | PreparedWorkflowRecovery;
    }>;
