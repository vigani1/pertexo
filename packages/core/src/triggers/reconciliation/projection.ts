import type { WorkflowTriggerProjection } from './trigger-reconciliation.types.js';
import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  httpPollConfigSchema,
  DATABASE_POLL_TRIGGER,
  POSTGRES_CONNECTION_SLOT,
  databasePollConfigSchema,
  isPollingTriggerDefinition,
  HTTP_POLL_CONNECTION_SLOT,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
} from '@pertexo/workflow-model';
import { canonicalJson } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';

import { CORE_SCHEDULE_CONFIG_SCHEMA } from '@pertexo/nodes-core';
import { z } from 'zod';

function triggerKind(
  definition: Readonly<{ key: string; version: number }>,
): WorkflowTriggerProjection['kind'] | null {
  const identity = `${definition.key}@${String(definition.version)}`;
  if (identity === 'core.webhook@1') return 'webhook';
  if (identity === 'core.schedule@1') return 'schedule';
  if (isPollingTriggerDefinition(definition)) return 'polling';
  return null;
}

const triggerConfigSchemas = {
  webhook: CORE_WEBHOOK_CONFIG_SCHEMA,
  schedule: CORE_SCHEDULE_CONFIG_SCHEMA,
};

const pollConnectionRefs = z
  .object({
    [HTTP_POLL_CONNECTION_SLOT]: z.uuid().optional(),
  })
  .optional();

export const triggerGraphSchema = z
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
  const graph = triggerGraphSchema.parse(graphInput);
  return Object.freeze(
    graph.nodes
      .flatMap((node): WorkflowTriggerProjection[] => {
        const kind = triggerKind(node.definition);
        if (kind === null) return [];
        // Graph disablement is execution-only. Published external trigger
        // identity remains materialized so deliveries/scans retain stable
        // ingress and occurrence semantics; stored trigger configuration has
        // its own independent enable/disable lifecycle.
        const config =
          kind === 'polling'
            ? pollConfig(node)
            : triggerConfigSchemas[kind].parse(node.config);
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

function pollConfig(
  node: z.output<typeof triggerGraphSchema>['nodes'][number],
) {
  if (node.definition.key === DATABASE_POLL_TRIGGER.key) {
    const refs = z
      .object({ [POSTGRES_CONNECTION_SLOT]: z.uuid() })
      .parse(node.connectionRefs);
    return {
      ...databasePollConfigSchema.parse(node.config),
      source: 'postgres',
      connectionId: refs[POSTGRES_CONNECTION_SLOT],
    };
  }
  const settings = httpPollConfigSchema.parse(node.config);
  const connectionId = pollConnectionRefs.parse(node.connectionRefs)?.[
    HTTP_POLL_CONNECTION_SLOT
  ];
  return connectionId === undefined ? settings : { ...settings, connectionId };
}
