import type { Worker } from 'node:worker_threads';
import { utf8ByteLength } from '../../values/text.js';
import type { GraphValidationResult } from '../../graph/validation/contract.js';
import {
  AUTHORING_VALIDATION_BUDGET as budget,
  AuthoringValidationUnavailableError,
  type AuthoringValidationUnavailableReason,
} from './contracts.js';
import { replySchema, type PendingBatch } from './worker-contract.js';
import { assertReportBudget } from './graph.js';
export function authoringMessageHandler({
  job,
  worker,
  isFinished,
  beginParsing,
  finish,
}: Readonly<{
  job: PendingBatch;
  worker: Worker;
  isFinished: () => boolean;
  beginParsing: () => void;
  finish: (
    reason?: AuthoringValidationUnavailableReason,
    report?: GraphValidationResult,
  ) => Promise<void>;
}>): (input: unknown) => void {
  let ready = false;
  let started = false;
  return (input: unknown): void => {
    if (isFinished()) return;
    try {
      if (utf8ByteLength(JSON.stringify(input)) > budget.reportBytes + 256) {
        void finish('report_limit');
        return;
      }
      const parsed = replySchema.safeParse(input);
      if (!parsed.success) {
        void finish('invalid_response');
        return;
      }
      const message = parsed.data;
      if (message.kind === 'ready') {
        if (ready) {
          void finish('invalid_response');
          return;
        }
        ready = true;
        beginParsing();
        worker.postMessage({ id: job.id, ...job.payload });
        job.payload = undefined;
        return;
      }
      if (message.id !== job.id || !ready) {
        void finish('invalid_response');
        return;
      }
      if (message.kind === 'started') {
        if (started) {
          void finish('invalid_response');
          return;
        }
        started = true;
        return;
      }
      if (!started) {
        void finish('invalid_response');
        return;
      }
      if (message.kind === 'unavailable') {
        void finish(message.reason);
        return;
      }
      assertReportBudget(message.report);
      void finish(undefined, message.report);
    } catch (error: unknown) {
      void finish(
        error instanceof AuthoringValidationUnavailableError
          ? error.reason
          : 'invalid_response',
      );
    }
  };
}
