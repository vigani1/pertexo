import type {
  AuditFilter,
  AuditQuery,
  AuditPage,
  GovernanceSettings,
} from '@pertexo/contracts';
export type GovernanceScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export class GovernanceError extends Error {
  override readonly name = 'GovernanceError';
  constructor(
    readonly reason: 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
export interface GovernanceStore {
  list(input: GovernanceScope & { query: AuditQuery }): Promise<AuditPage>;
  settings(input: GovernanceScope): Promise<GovernanceSettings>;
  configure(
    input: GovernanceScope & {
      expectedRevision: number;
      auditRetentionDays?: number | undefined;
      requirePublishApproval?: boolean | undefined;
      idempotencyKey: string;
    },
  ): Promise<GovernanceSettings>;
  exportCsv(
    input: GovernanceScope & {
      query: AuditFilter;
      consume: (
        csv: AsyncIterable<string>,
        metadata: Readonly<{ filename: string; storedBytes: number }>,
      ) => Promise<void>;
    },
  ): Promise<void>;
  close(): Promise<void>;
}
