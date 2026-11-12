import type { AccessibleWorkspace } from '@pertexo/contracts';

import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import type { useAutoPauseCommand } from '../../data/mutations/use-auto-pause-command';
export type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;
export function CommandProblem({
  command,
}: Readonly<{
  command: ReturnType<typeof useAutoPauseCommand>;
}>) {
  if (command.problem === undefined) return null;
  return <Notice tone="destructive">{command.problem}</Notice>;
}
