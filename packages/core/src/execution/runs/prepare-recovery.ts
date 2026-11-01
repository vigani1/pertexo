import { validateCallableValue } from '@pertexo/workflow-model';
import type { WorkflowRecoveryPreparation } from '../../runs/index.js';
import {
  parseCheckpoint,
  planRecovery,
  seedRecovery,
  selectRecoveryPrefix,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../workflows/verify-projection.js';

/** Preview and atomic acceptance share the same verified source and pure policy. */
export function recoveryPreparation(
  verification: PersistedWorkflowProjectionVerificationOptions,
): WorkflowRecoveryPreparation {
  return (metadata) => {
    const sourceCompletedAt = metadata.run.completedAt?.toISOString();
    if (sourceCompletedAt === undefined)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    if (
      metadata.workflow.id !== metadata.run.workflowVersionId ||
      metadata.workflow.workflowId !== metadata.run.workflowId ||
      metadata.workflow.workspaceId !== metadata.run.workspaceId
    )
      return { kind: 'refused', reason: 'version_unavailable' };
    let candidate: ReturnType<typeof selectRecoveryPrefix>;
    try {
      const executable = verifyPersistedWorkflowProjection(
        metadata.workflow,
        verification,
      );
      candidate = selectRecoveryPrefix({
        executable,
        source: {
          id: metadata.run.id,
          status: metadata.run.status,
          workflowVersionId: metadata.run.workflowVersionId,
          completedAt: sourceCompletedAt,
          checkpoint: parseCheckpoint(metadata.checkpoint),
          nodes: metadata.nodes,
        },
      });
    } catch (error) {
      if (error instanceof WorkflowEngineError)
        return {
          kind: 'refused',
          reason:
            error.code === 'executable_invalid'
              ? 'version_unavailable'
              : 'evidence_unavailable',
        };
      throw error;
    }
    if (candidate.kind === 'refused') return candidate;
    const selected = candidate;
    return {
      kind: 'candidate',
      nodeRunIds: selected.prefix.map((node) => node.source.id),
      complete: (values) => {
        const plan = planRecovery(selected, values);
        if (plan.kind === 'refused') return plan;
        const callable = selected.executable.envelope.graph.callable;
        if (
          callable !== undefined &&
          (plan.input === undefined ||
            validateCallableValue(callable.input, plan.input) !== undefined)
        )
          return { kind: 'refused', reason: 'evidence_unavailable' };

        return {
          kind: 'eligible',
          input: plan.input,
          preview: {
            kind: 'eligible',
            workflowVersionId: metadata.workflow.id,
            versionNumber: metadata.workflow.versionNumber,
            nodeRunId: selected.target.id,
            nodeId: selected.target.nodeId,
            nodeLabel:
              metadata.failedStep?.nodeId === selected.target.nodeId
                ? metadata.failedStep.label
                : null,
            reusedCount: selected.prefix.length,
            sourceCompletedAt,
            effectRisk: selected.effectRisk,
          },
          seed: (identity) => seedRecovery(plan, identity),
        };
      },
    };
  };
}
