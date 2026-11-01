import type { WorkspaceCapacityLimit } from '@pertexo/contracts';

export const CAPACITY_LIMIT_LABELS: Readonly<
  Record<WorkspaceCapacityLimit, string>
> = {
  active: 'Active runs',
  queue: 'Queued runs',
  artifact_bytes: 'File storage',
  artifact_count: 'File count',
};
