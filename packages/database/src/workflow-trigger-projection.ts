import { createHash } from 'node:crypto';

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

const graphSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string().min(1).max(128),
          definition: z
            .object({ key: z.string(), version: z.number().int() })
            .passthrough(),
          config: z.unknown(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

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
        if (identity !== 'core.webhook@1' && identity !== 'core.schedule@1')
          return [];
        const kind = identity === 'core.webhook@1' ? 'webhook' : 'schedule';
        const config =
          kind === 'webhook'
            ? webhookConfigSchema.parse(node.config)
            : scheduleConfigSchema.parse(node.config);
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
