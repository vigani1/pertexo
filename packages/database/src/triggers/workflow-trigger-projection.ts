import { createHash } from 'node:crypto';

import { CORE_SCHEDULE_CONFIG_SCHEMA_V2 } from '@pertexo/nodes-core';
import { z } from 'zod';

const webhookConfigSchema = z.object({}).strict();
const scheduleConfigSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: z
        .string()
        .min(9)
        .max(255)
        .regex(
          /^[0-9*/?,-]+ [0-9*/?,-]+ [0-9*/?,-]+ [0-9*/?,-]+ [0-9*/?,-]+$/u,
        ),
      timezone: z.string().min(1).max(255),
      misfirePolicy: z.enum(['catch_up_once', 'skip']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z.number().int().min(1).max(43_200),
      misfirePolicy: z.enum(['catch_up_once', 'skip']),
    })
    .strict(),
]);

function triggerKind(
  identity: string,
): WorkflowTriggerProjection['kind'] | null {
  if (identity === 'core.webhook@1') return 'webhook';
  if (
    identity === 'core.schedule@1' ||
    identity === 'core.schedule@2' ||
    identity === 'core.schedule@3'
  )
    return 'schedule';
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

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
        let config: Readonly<Record<string, unknown>>;
        if (kind === 'webhook') config = webhookConfigSchema.parse(node.config);
        else if (
          identity === 'core.schedule@2' ||
          identity === 'core.schedule@3'
        )
          config = CORE_SCHEDULE_CONFIG_SCHEMA_V2.parse(node.config);
        else config = scheduleConfigSchema.parse(node.config);
        const digest = createHash('sha256')
          .update(canonicalJson({ config, kind }))
          .digest('hex');
        return [
          Object.freeze({
            nodeId: node.id,
            kind,
            config: Object.freeze(config),
            configFingerprint: `trigger:v1:sha256:${digest}`,
          }),
        ];
      })
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
}
