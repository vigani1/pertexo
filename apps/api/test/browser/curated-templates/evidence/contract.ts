import { z } from 'zod';
import {
  workflowNodeRunStatusSchema,
  workflowRunStatusSchema,
} from '@pertexo/contracts';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import type { useBetterAuthRealApi } from '../../../support/better-auth/real-api.support.js';

export type Api = ReturnType<typeof useBetterAuthRealApi>;

const reviewedNodeIds = new Set(
  CURATED_WORKFLOW_TEMPLATES.flatMap((template) =>
    template.manifest.graph.nodes.flatMap((node) => [
      node.id,
      ...(node.structured?.kind === 'for_each'
        ? node.structured.body.nodes.map((child) => child.id)
        : []),
    ]),
  ),
);

export const terminalStatuses = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

/** Fixed owned-fixture metadata only; never raw input/config/output or errors. */
export function curatedRunDiagnostic(
  status: unknown,
  nodes: readonly unknown[],
) {
  return {
    status: workflowRunStatusSchema.safeParse(status).data ?? 'unknown',
    nodes: nodes.slice(0, 64).flatMap((node) => {
      if (
        typeof node !== 'object' ||
        node === null ||
        !('nodeId' in node) ||
        typeof node.nodeId !== 'string' ||
        !reviewedNodeIds.has(node.nodeId)
      )
        return [];
      const state =
        'status' in node
          ? workflowNodeRunStatusSchema.safeParse(node.status).data
          : undefined;
      const code =
        'safeErrorCode' in node &&
        typeof node.safeErrorCode === 'string' &&
        /^[a-z][a-z0-9_.-]{0,127}$/u.test(node.safeErrorCode)
          ? node.safeErrorCode
          : null;
      return [
        {
          nodeId: node.nodeId,
          status: state ?? 'unknown',
          safeErrorCode: code,
        },
      ];
    }),
  };
}

export const curatedWebhookInputCases = Object.freeze({
  // The reviewed mapping itself creates the Validate input's payload property.
  accepted: Object.freeze({ type: 'notification' }),
  rejected: Object.freeze({ type: 'other' }),
  missing: Object.freeze({}),
});

// Synthetic manual input matching schedule@3's registered trigger envelope;
// not evidence of a persisted trigger registration or automatic timer delivery.
export const curatedScheduleInputCase = Object.freeze({
  triggerId: '00000000-0000-4000-8000-000000000006',
  nodeId: 'schedule-start',
  scheduledAt: '2026-10-02T00:00:00.000Z',
});

export const curatedTemplateEffectsSchema = z.strictObject({
  phase: z.literal('curated-template-effects'),
  observations: z
    .array(
      z.strictObject({
        kind: z.enum(['http', 'slack']),
        status: z.union([z.literal(200), z.literal(204), z.literal(500)]),
        bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .max(32),
  pendingHttpResponses: z.number().int().min(0).max(16),
});
