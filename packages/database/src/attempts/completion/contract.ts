import type { z } from 'zod';

import type { completionSchema } from '../contract.js';

export type CompletionInput = z.output<typeof completionSchema>;

type ExecutorOutcome = Extract<
  CompletionInput['outcome'],
  { status: 'executor_failure' }
>;

export type SuspendedOutcome = Extract<
  CompletionInput['outcome'],
  { status: 'suspended' }
>;

export interface CompletionReceiptRow {
  readonly completed_at: Date | null;
  readonly payload_checksum: string;
}

export interface LockedAttemptRow {
  readonly current_attempt: boolean;
  readonly attempt_status: string;
  readonly error_summary: string | null;
  readonly code_diagnostics: unknown;
  readonly executor_error_kind: string | null;
  readonly executor_retry_after_millis: number | null;
  readonly executor_failure_kind: string | null;
  readonly executor_possibly_dispatched: boolean | null;
  readonly fence_token: string;
  readonly lease_valid: boolean;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly node_status: string;
  readonly output_ref: unknown;
  readonly safe_error_code: string | null;
  readonly retry_decision: string | null;
  readonly suspension_recorded: boolean;
  readonly wait_kind: string | null;
}

export interface CompletionFields {
  readonly durableStatus: string;
  readonly errorSummary: string | null;
  readonly executorOutcome: ExecutorOutcome | undefined;
  readonly safeErrorCode: string | null;
  readonly suspendedOutcome: SuspendedOutcome | undefined;
}
