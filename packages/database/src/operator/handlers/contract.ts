import type { AuditMetadata } from '../../governance/audit/events.repository.js';
/**
 * What a command did: its outcome, its stored result, whether it waits on a
 * worker, and facts its audit event records beyond the request.
 */
export type OperatorDecision = Readonly<{
  outcome: string;
  result: Readonly<Record<string, unknown>>;
  pending?: boolean;
  auditMetadata?: AuditMetadata;
}>;
