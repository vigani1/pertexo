import type { claimSchema } from './input.js';

import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.js';

import type { Pool } from 'pg';
import type { z } from 'zod';

import type { ScheduleOccurrenceDisposition } from '../misfire.js';

import type { RecordedScheduleOccurrence } from '../contract.js';

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

export type ClaimRetirement =
  | Readonly<{ kind: 'defer'; retryAfterSeconds: number }>
  | Readonly<{ kind: 'fail' | 'release' }>;
