import type { CompleteAttemptInput } from '../node-attempt.js';
import type { inboxReceipts } from '@pertexo/database/schema';
import type { lockCompletionAttempt } from './attempt-completion.repository.js';

type ExecutorOutcome = Extract<
  CompleteAttemptInput['outcome'],
  { status: 'executor_failure' }
>;

export type SuspendedOutcome = Extract<
  CompleteAttemptInput['outcome'],
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
  readonly durableStatus: Exclude<
    CompleteAttemptInput['outcome']['status'],
    'suspended' | 'executor_failure'
  >;
  readonly errorSummary: string | null;
  readonly executorOutcome: ExecutorOutcome | undefined;
  readonly safeErrorCode: string | null;
  readonly suspendedOutcome: SuspendedOutcome | undefined;
}
