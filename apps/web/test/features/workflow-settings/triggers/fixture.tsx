import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import { userId, workflowId, workspaceId } from '../fixtures';
export const triggersPath = `/w/${workspaceId}/workflows/${workflowId}/triggers`;

export const schedulesKey = [
  'identity',
  userId,
  'workspace',
  workspaceId,
  'workflow',
  workflowId,
  'settings',
  'schedules',
] as const;

export async function acknowledgeCredentials(event: UserEvent) {
  const dialog = await screen.findByRole('dialog', { name: 'Store these now' });
  const done = within(dialog).getByRole('button', { name: 'Done' });
  expect(done).toBeDisabled();
  await event.click(
    within(dialog).getByRole('switch', { name: 'I’ve stored these' }),
  );
  await event.click(done);
}
