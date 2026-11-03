import type { AuditFilter, AuditQuery } from '@pertexo/contracts';
import type { WorkspaceActor } from '../shared/workspace-access.js';

export class GovernanceError extends Error {
  override readonly name = 'GovernanceError';
  constructor(
    readonly reason: 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

export type ListAuditInput = WorkspaceActor & Readonly<{ query: AuditQuery }>;

export type ConfigureGovernanceInput = WorkspaceActor &
  Readonly<{
    expectedRevision: number;
    auditRetentionDays?: number | undefined;
    requirePublishApproval?: boolean | undefined;
    idempotencyKey: string;
  }>;

export type ExportAuditInput = WorkspaceActor &
  Readonly<{
    query: AuditFilter;
    consume: (
      csv: AsyncIterable<string>,
      metadata: Readonly<{ filename: string; storedBytes: number }>,
    ) => Promise<void>;
  }>;
