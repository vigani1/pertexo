/**
 * What a command did: its outcome, its stored result, whether it waits on a
 * worker, and facts its audit event records beyond the request.
 */
export type OperatorDecision = Readonly<{
  outcome: string;
  result: Readonly<Record<string, unknown>>;
  pending?: boolean;
  auditMetadata?: Readonly<Record<string, unknown>>;
}>;

export const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export /** Due nodes one resume marks; the result says when more remain. */
const RESUME_PAGE = 100;
