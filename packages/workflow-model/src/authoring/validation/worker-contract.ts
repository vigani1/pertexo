import type { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { WorkflowGraph } from '../../graph/contract.js';
import type { GraphValidationResult } from '../../graph/validation/contract.js';
import {
  validationReportSchema,
  type AuthoringValidationUnavailableReason,
  type AuthoringValidationUnavailableError,
  type WorkflowExpressionPolicyProjection,
} from './contracts.js';

export const replySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }).strict(),
  z
    .object({ kind: z.literal('started'), id: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      id: z.number().int().positive(),
      report: validationReportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      id: z.number().int().positive(),
      reason: z.enum(['report_limit', 'worker_failed']),
    })
    .strict(),
]);

export type Limits = Readonly<{
  maxActive: number;
  maxQueued: number;
  maxQueuedBytes: number;
  queueMs: number;
  startupMs: number;
  parseMs: number;
  terminationMs: number;
}>;

export interface PendingBatch {
  id: number;
  bytes: number;
  payload:
    | {
        graph: WorkflowGraph;
        policies: WorkflowExpressionPolicyProjection;
        workspaceVariableNames?: readonly string[];
      }
    | undefined;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  queueDeadline: number | undefined;
  resolve: (report: GraphValidationResult) => void;
  reject: (error: AuthoringValidationUnavailableError) => void;
}

export interface ActiveBatch {
  worker: Worker;
  exited: boolean;
  stop: (reason: AuthoringValidationUnavailableReason) => Promise<void>;
}
