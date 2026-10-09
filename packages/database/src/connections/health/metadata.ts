import { z } from 'zod';

import type { ConnectionRecord } from '../records.js';

const transitionSourceSchema = z.enum(['run', 'test', 'rotation', 'revoke']);
export const connectionHealthSnapshotSchema = z.object({
  lastRunObservedAt: z.iso.datetime().nullable().optional(),
  lastHealthTransitionAt: z.iso.datetime().nullable().optional(),
  lastHealthTransitionSource: transitionSourceSchema.nullable().optional(),
});

/** Old durable snapshots omit these fields; normalize them without inventing evidence. */
export function deserializeConnectionHealthMetadata(
  value: z.output<typeof connectionHealthSnapshotSchema>,
): Required<
  Pick<
    ConnectionRecord,
    | 'lastRunObservedAt'
    | 'lastHealthTransitionAt'
    | 'lastHealthTransitionSource'
  >
> {
  return {
    lastRunObservedAt:
      value.lastRunObservedAt == null
        ? null
        : new Date(value.lastRunObservedAt),
    lastHealthTransitionAt:
      value.lastHealthTransitionAt == null
        ? null
        : new Date(value.lastHealthTransitionAt),
    lastHealthTransitionSource: value.lastHealthTransitionSource ?? null,
  };
}

/** Safe current-credential provenance; no revision or dispatch identity escapes. */
export function mapConnectionHealthMetadata(
  row: Readonly<Record<string, unknown>>,
): Required<
  Pick<
    ConnectionRecord,
    | 'lastRunObservedAt'
    | 'lastHealthTransitionAt'
    | 'lastHealthTransitionSource'
  >
> {
  return {
    lastRunObservedAt:
      row.last_run_observed_at == null
        ? null
        : z.date().parse(row.last_run_observed_at),
    lastHealthTransitionAt:
      row.last_health_transition_at == null
        ? null
        : z.date().parse(row.last_health_transition_at),
    lastHealthTransitionSource:
      row.last_health_transition_source == null
        ? null
        : transitionSourceSchema.parse(row.last_health_transition_source),
  };
}
