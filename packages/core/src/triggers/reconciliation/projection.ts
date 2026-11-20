import type { WorkflowTriggerProjection } from './trigger-reconciliation.types.js';
import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  httpPollConfigSchema,
  HTTP_POLL_TRIGGER,
  HTTP_POLL_CONNECTION_SLOT,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
} from '@pertexo/workflow-model';
import { canonicalJson } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';

import { CORE_SCHEDULE_CONFIG_SCHEMA } from '@pertexo/nodes-core';
import { z } from 'zod';

function triggerKind(
  identity: string,
): WorkflowTriggerProjection['kind'] | null {
  if (identity === 'core.webhook@1') return 'webhook';
  if (identity === 'core.schedule@1') return 'schedule';
  if (
    identity === `${HTTP_POLL_TRIGGER.key}@${String(HTTP_POLL_TRIGGER.version)}`
  )
    return 'polling';
  return null;
}

const triggerConfigSchemas = {
  webhook: CORE_WEBHOOK_CONFIG_SCHEMA,
  schedule: CORE_SCHEDULE_CONFIG_SCHEMA,
  polling: httpPollConfigSchema,
};

const pollConnectionRefs = z
  .object({
    [HTTP_POLL_CONNECTION_SLOT]: z.uuid().optional(),
  })
  .optional();

const graphSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z
            .string()
            .min(1)
            .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength),
          definition: z.looseObject({
            key: z.string(),
            version: z.number().int(),
          }),
          disabled: z.boolean().optional(),
          config: z.unknown(),
        })
        .loose(),
    ),
  })
  .loose();

export function workflowTriggerProjection(
  graphInput: unknown,
): readonly WorkflowTriggerProjection[] {
  const graph = graphSchema.parse(graphInput);
  return Object.freeze(
    graph.nodes
      .flatMap((node): WorkflowTriggerProjection[] => {
        const identity = `${node.definition.key}@${String(node.definition.version)}`;
        const kind = triggerKind(identity);
        if (kind === null) return [];
        // Graph disablement is execution-only. Published external trigger
        // identity remains materialized so deliveries/scans retain stable
        // ingress and occurrence semantics; stored trigger configuration has
        // its own independent enable/disable lifecycle.
        const settings = triggerConfigSchemas[kind].parse(node.config);
        const connectionId =
          kind === 'polling'
            ? pollConnectionRefs.parse(node.connectionRefs)?.[
                HTTP_POLL_CONNECTION_SLOT
              ]
            : undefined;
        const config =
          connectionId !== undefined ? { ...settings, connectionId } : settings;
        const digest = createHash('sha256')
          .update(canonicalJson({ config, kind }))
          .digest('hex');
        return [
          Object.freeze({
            nodeId: node.id,
            kind,
            config: Object.freeze(config),
            configFingerprint: `trigger:sha256:${digest}`,
          }),
        ];
      })
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
}
