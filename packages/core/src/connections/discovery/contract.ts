import type { workflowIntegrationUsage } from '@pertexo/database/schema';

// Projection joins workflows and versions with aggregated operation keys.
export type ConnectionUsageRecord = Readonly<{
  workflowId: string;
  workflowName: string;
  workflowLifecycleStatus: 'active' | 'archived';
  workflowVersionId: string;
  versionNumber: number;
  isCurrentPublication: boolean;
  operationKeys: readonly string[];
}>;

export type ConnectionUsageCursor = Readonly<{ workflowVersionId: string }>;

export type ConnectionUsagePage = Readonly<{
  items: readonly ConnectionUsageRecord[];
  nextCursor?: ConnectionUsageCursor;
}>;

export type ListConnectionUsageInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  limit?: number;
  after?: ConnectionUsageCursor;
}>;

export type ConnectionUsageDatabase = Readonly<{
  listConnectionUsage(
    input: ListConnectionUsageInput,
  ): Promise<ConnectionUsagePage>;
}>;

export type WorkflowIntegrationImpactRecord = Pick<
  typeof workflowIntegrationUsage.$inferSelect,
  'workflowVersionId' | 'providerKey' | 'operationKey' | 'connectionId'
>;

export type WorkflowIntegrationImpactPage = Readonly<{
  items: readonly WorkflowIntegrationImpactRecord[];
  nextCursor?: WorkflowIntegrationImpactRecord;
}>;

export type FindProviderOperationImpactInput = Readonly<{
  workspaceId: string;
  providerKey: string;
  operationKey: string;
  limit?: number;
  after?: Readonly<{ workflowVersionId: string; connectionId: string }>;
}>;

export type FindConnectionImpactInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  limit?: number;
  after?: Readonly<{
    workflowVersionId: string;
    providerKey: string;
    operationKey: string;
  }>;
}>;

export type WorkflowIntegrationUsageDatabase = Readonly<{
  findProviderOperationImpact(
    input: FindProviderOperationImpactInput,
  ): Promise<WorkflowIntegrationImpactPage>;
  findConnectionImpact(
    input: FindConnectionImpactInput,
  ): Promise<WorkflowIntegrationImpactPage>;
  close(): Promise<void>;
}>;
