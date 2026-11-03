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
