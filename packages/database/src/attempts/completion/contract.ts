import type { inboxReceipts } from '../../schema/transport.js';
import type { lockCompletionAttempt } from './records.repository.js';
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

export type CompletionReceiptRow = Pick<
  typeof inboxReceipts.$inferSelect,
  'completedAt' | 'payloadChecksum'
>;
export type LockedAttemptRow = Awaited<
  ReturnType<typeof lockCompletionAttempt>
>[number];

export interface CompletionFields {
  readonly durableStatus: string;
  readonly errorSummary: string | null;
  readonly executorOutcome: ExecutorOutcome | undefined;
  readonly safeErrorCode: string | null;
  readonly suspendedOutcome: SuspendedOutcome | undefined;
}
