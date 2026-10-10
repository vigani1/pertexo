import { canonicalJson } from '../../platform/canonical-json.js';
import { createHash } from 'node:crypto';

import { CORE_SCHEDULE_CONFIG_SCHEMA } from '@pertexo/nodes-core';
import { z } from 'zod';

const webhookConfigSchema = z.object({}).strict();

function triggerKind(
  identity: string,
): WorkflowTriggerProjection['kind'] | null {
  if (identity === 'core.webhook@1') return 'webhook';
  if (identity === 'core.schedule@1') return 'schedule';
  return null;
}

const graphSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string().min(1).max(128),
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

export type WorkflowTriggerProjection = Readonly<{
  nodeId: string;
  kind: 'schedule' | 'webhook';
  config: Readonly<Record<string, unknown>>;
  configFingerprint: string;
}>;

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
        const config: Readonly<Record<string, unknown>> =
          kind === 'webhook'
            ? webhookConfigSchema.parse(node.config)
            : CORE_SCHEDULE_CONFIG_SCHEMA.parse(node.config);
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
