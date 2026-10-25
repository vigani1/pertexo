import { workflowKeys } from '@/features/workflows/queries.public';
import { screen } from '@testing-library/react';
import { userId, workflowId, workspaceId } from '../fixtures';
export const settingsPath = `/w/${workspaceId}/workflows/${workflowId}/settings`;

export const detailKey = workflowKeys.detail(userId, workspaceId, workflowId);

export function region(name: string) {
  return screen.getByRole('region', { name, hidden: true });
}
