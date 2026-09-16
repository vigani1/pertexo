import { mutationOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { createWorkflow } from './workflows.api';

export function createWorkflowMutationOptions(
  apiClient: ApiClient,
  workspaceId: string,
) {
  return mutationOptions({
    mutationFn: (input: Readonly<{ name: string; idempotencyKey: string }>) =>
      createWorkflow(apiClient, workspaceId, input),
  });
}
