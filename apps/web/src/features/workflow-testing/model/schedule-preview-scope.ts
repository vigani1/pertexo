import { createContext } from 'react';
import type { ApiClient } from '@/lib/api/client';

/** Where a draft schedule's preview is computed: the editor's workflow. */
type SchedulePreviewScopeValue = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
}>;

/**
 * Provided by the editor around its inspector, so the Schedule step's
 * builder can preview its rule without threading the API through every
 * inspector layer. Without it, no preview is shown.
 */
export const SchedulePreviewScope =
  createContext<SchedulePreviewScopeValue | null>(null);
