import type { JsonValue } from '@pertexo/workflow-model';
import type {
  NodeExecutorErrorKind,
  NodeExecutorFailureKind,
} from '@pertexo/node-sdk/server';
import type { AttemptAdmissionPlan } from '../workflow-execution.js';

export type InlineAttemptSettlement = AttemptAdmissionPlan &
  Readonly<{
    attemptId: string;
    startedAt: string;
    durationMillis: number;
    input?: JsonValue;
  }> &
  (
    | Readonly<{ kind: 'succeeded'; output: JsonValue }>
    | Readonly<{ kind: 'failed' | 'timed_out'; safeErrorCode: string }>
    | (Readonly<{
        kind: 'executor_failure';
        failureKind: NodeExecutorFailureKind;
        errorKind: NodeExecutorErrorKind;
        safeErrorCode: string;
        errorSummary?: string;
        minimumRetryDelayMillis?: number;
      }> &
        (
          | Readonly<{ disposition: 'retry'; dueAt: string }>
          | Readonly<{ disposition: 'failed' | 'canceled' | 'outcome_unknown' }>
        ))
  );
