import type { NodeAttemptRunStore } from '../contract.js';
import type { inboxReceipts } from '../../schema/transport.js';
import type { lockCompletionAttempt } from './records.repository.js';

export type CompletionInput = Parameters<NodeAttemptRunStore['complete']>[0];

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
  readonly durableStatus: Exclude<
    CompletionInput['outcome']['status'],
    'suspended' | 'executor_failure'
  >;
  readonly errorSummary: string | null;
  readonly executorOutcome: ExecutorOutcome | undefined;
  readonly safeErrorCode: string | null;
  readonly suspendedOutcome: SuspendedOutcome | undefined;
}
