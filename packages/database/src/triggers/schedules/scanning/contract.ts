import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.js';

import type { Pool } from 'pg';
import { z } from 'zod';

import type { ScheduleOccurrenceDisposition } from '../misfire.js';

import type { RecordedScheduleOccurrence } from '../pause.queries.js';

export const claimSchema = z.object({
  trigger_id: z.uuid(),
  workspace_id: z.uuid(),
  workflow_id: z.uuid(),
  workflow_version_id: z.uuid(),
  node_id: z.string(),
  recurrence_kind: z.enum(['cron', 'interval']),
  cron_expression: z.string().nullable(),
  timezone: z.string().nullable(),
  interval_minutes: z.number().int().nullable(),
  misfire_policy: z.enum(['catch_up_once', 'skip']),
  config_fingerprint: z.string(),
  anchor_at: z.date(),
  next_fire_at: z.date(),
  lease_token: z.uuid(),
  observed_at: z.date(),
});

export type ScanDueSchedulesResult = Readonly<{
  claimed: number;
  accepted: number;
  skipped: number;
  paused: number;
  deferred: number;
  maxLagSeconds: number;
}>;

export interface ScheduleTriggerScanner {
  scanDue(
    input: Readonly<{
      leaseOwner: string;
      limit: number;
      leaseSeconds: number;
      /**
       * ADR 049: how late, from 60 through 3,600 seconds, a `skip` schedule's
       * greatest due occurrence may be observed and still be admitted.
       */
      onTimeWindowSeconds: number;
      checkpointFactory: InitialCheckpointFactory;
      signal?: AbortSignal;
    }>,
  ): Promise<ScanDueSchedulesResult>;
  close(): Promise<void>;
}

export class ScheduleClaimLostError extends Error {
  public override readonly name = 'ScheduleClaimLostError';
}

export type ScheduleClaim = z.output<typeof claimSchema>;

export type ScanDueInput = Parameters<ScheduleTriggerScanner['scanDue']>[0];

export type ClaimOutcome = RecordedScheduleOccurrence | 'deferred';

export type ClaimedOccurrence = Readonly<{
  disposition: ScheduleOccurrenceDisposition;
  nextAt: Date;
  scheduledAt: Date;
}>;

export type ScannerResources = Readonly<{
  acceptancePool: Pool;
  claimPool: Pool;
}>;
