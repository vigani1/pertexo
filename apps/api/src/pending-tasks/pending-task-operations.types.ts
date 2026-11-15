import type { PendingTaskStore } from '@pertexo/core/runs';
import type { IdentityWorkspaceStore } from '@pertexo/core/tenant-access';

/** Core's task store, plus the workspace people an approval's audience lists. */
export type PendingTaskOperations = PendingTaskStore &
  Readonly<{ audience: IdentityWorkspaceStore['listWorkspacePeople'] }>;
