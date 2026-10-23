import { z } from 'zod';
import { createApiProblemSchema } from '../../errors/api-problem.js';
import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_RECOVERY_REFUSALS,
} from '@pertexo/workflow-model';

const workflowRecoveryEffectRiskSchema = z.enum([
  'ordinary',
  'possible_effects',
  'unknown_outcome',
]);
export const workflowRecoveryRefusalSchema = z
  .object({
    kind: z.literal('refused'),
    reason: z.enum(WORKFLOW_RECOVERY_REFUSALS),
  })
  .strict();
export const workflowRecoveryPreviewSchema = z.discriminatedUnion('kind', [
  workflowRecoveryRefusalSchema,
  z
    .object({
      kind: z.literal('eligible'),
      workflowVersionId: z.uuid(),
      versionNumber: z.number().int().positive(),
      nodeRunId: z.uuid(),
      nodeId: z.string().min(1).max(128),
      nodeLabel: z.string().max(200).nullable(),
      reusedCount: z
        .number()
        .int()
        .min(0)
        .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes),
      sourceCompletedAt: z.iso.datetime({ offset: true }),
      effectRisk: workflowRecoveryEffectRiskSchema,
    })
    .strict(),
]);
export const workflowRecoveryRequestSchema = z
  .object({
    workflowVersionId: z.uuid(),
    nodeRunId: z.uuid(),
    deadlineAt: z.iso.datetime({ offset: true }).optional(),
    acknowledgePossibleEffects: z.literal(true).optional(),
    acknowledgeUnknownOutcome: z.literal(true).optional(),
  })
  .strict();
export const workflowRecoverySummarySchema = z
  .object({
    targetNodeRunId: z.uuid(),
    targetNodeId: z.string().min(1).max(128),
    reusedCount: z
      .number()
      .int()
      .min(0)
      .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes),
    effectRisk: workflowRecoveryEffectRiskSchema,
    effectsAcknowledged: z.boolean(),
  })
  .strict();
export const workflowNodeReuseSchema = z
  .object({
    sourceRunId: z.uuid(),
    sourceNodeRunId: z.uuid(),
    sourceCompletedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type WorkflowRecoveryPreview = z.infer<
  typeof workflowRecoveryPreviewSchema
>;
export type WorkflowRecoveryRequest = z.infer<
  typeof workflowRecoveryRequestSchema
>;
export type WorkflowNodeReuse = z.infer<typeof workflowNodeReuseSchema>;

export const workflowRecoveryUnavailableProblemSchema = createApiProblemSchema({
  code: z.literal('run.recovery_unavailable'),
  reason: z.enum(WORKFLOW_RECOVERY_REFUSALS),
});
