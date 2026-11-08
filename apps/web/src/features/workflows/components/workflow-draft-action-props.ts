import type { ComponentProps } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import type { DialogContent } from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';

/** Controlled saved-draft actions share the editor's save/conflict boundary. */
export type WorkflowDraftActionProps = Readonly<{
  workflow: WorkflowSummary;
  blocked?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName?: string;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
}>;
