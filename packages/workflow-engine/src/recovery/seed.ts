import { WORKFLOW_GRAPH_LIMITS, type JsonValue } from '@pertexo/workflow-model';
import { nodeProviderIdempotencyKey } from '../attempt/derive-provider-key.js';
import {
  createCheckpoint,
  parseCheckpoint,
} from '../checkpoint/create-and-parse.js';
import { WorkflowEngineError } from '../errors.js';
import type {
  BranchScopePart,
  InvocationState,
  SideEffectClass,
  WorkflowCheckpoint,
} from '../types.js';
import type { RecoveryPlan, RecoveryRefused } from './contract.js';

export interface RecoveryCopy {
  readonly id: string;
  readonly nodeId: string;
  readonly invocationKey: string;
  readonly branchPath?: readonly BranchScopePart[];
  readonly sideEffectClass: SideEffectClass;
  readonly providerIdempotencyKey?: string;
  readonly value: JsonValue;
  readonly sourceRunId: string;
  readonly sourceNodeRunId: string;
  readonly sourceCompletedAt: string;
}

/** New identities belong to acceptance; no source lease or key is carried over. */
export function seedRecovery(
  plan: RecoveryPlan,
  identity: Readonly<{
    runId: string;
    nodeRunIds: ReadonlyMap<string, string>;
  }>,
):
  | Readonly<{
      kind: 'seeded';
      checkpoint: WorkflowCheckpoint;
      copies: readonly RecoveryCopy[];
    }>
  | RecoveryRefused {
  const copies: RecoveryCopy[] = [];
  const invocations: InvocationState[] = [];
  for (const { source, definition, invocation } of plan.prefix) {
    const id = identity.nodeRunIds.get(source.id);
    const value = plan.outputs.get(source.id);
    const sourceCompletedAt = source.reused?.completedAt ?? source.completedAt;
    if (id === undefined || value === undefined || sourceCompletedAt === null)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    const key = nodeProviderIdempotencyKey(
      definition,
      identity.runId,
      invocation.invocationKey,
    );
    copies.push({
      id,
      nodeId: source.nodeId,
      invocationKey: invocation.invocationKey,
      sideEffectClass: definition.sideEffectClass,
      ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      ...(invocation.branchPath === undefined
        ? {}
        : { branchPath: invocation.branchPath }),
      value,
      sourceRunId: plan.source.id,
      sourceNodeRunId: source.id,
      sourceCompletedAt,
    });
    invocations.push({
      invocationKey: invocation.invocationKey,
      nodeId: invocation.nodeId,
      status: 'succeeded',
      attemptNumber: 0,
      output: { kind: 'reused', nodeRunId: id },
      ...(invocation.branchPath === undefined
        ? {}
        : { branchPath: invocation.branchPath }),
    });
  }
  try {
    const checkpoint = parseCheckpoint({
      ...createCheckpoint({
        workflowVersionId: plan.source.workflowVersionId,
        iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
        nextEventSequence: 2 + copies.length,
      }),
      invocations,
      branchSelections: plan.branchSelections,
    });
    return { kind: 'seeded', checkpoint, copies };
  } catch (error) {
    if (
      error instanceof WorkflowEngineError &&
      error.code === 'checkpoint_invalid'
    )
      return { kind: 'refused', reason: 'reuse_bounds' };
    throw error;
  }
}
