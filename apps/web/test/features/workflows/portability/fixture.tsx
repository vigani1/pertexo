import { WorkflowImportDialog } from '@/features/workflows/components/portability/workflow-import-dialog';
import { createApiClient } from '@/lib/api/client';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import { renderInRouter } from '../../../support/render-in-router';
import {
  discoveryHandlers,
  emptyGraph,
  userId,
  workspaceWith,
} from '../list/fixtures';
const fingerprint = `wf-compat:sha256:${'a'.repeat(64)}`;

export const manifest = {
  format: 'pertexo.workflow',
  graph: emptyGraph,
  requirements: {
    definitions: [],
  },
  connectionSlots: [],
};

export const preview = {
  manifestDigest: 'b'.repeat(64),
  compatibilityFingerprint: fingerprint,
  compatible: true,
  issues: [],
  truncated: false,
  connectionSlots: [],
};

export const client = () =>
  createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });

export const workspace = () =>
  accessibleWorkspaceSchema.parse(
    workspaceWith(['workflow:create', 'connection:read']),
  );

export function openImport() {
  mockServer.use(...discoveryHandlers());
  const onCreated = vi.fn();
  const result = renderInRouter(
    <WorkflowImportDialog
      onClose={vi.fn()}
      onCreated={onCreated}
      scope={{ apiClient: client(), userId, workspace: workspace() }}
    />,
  );
  return { ...result, event: userEvent.setup(), onCreated };
}

export async function prepareImport(event: ReturnType<typeof userEvent.setup>) {
  await event.upload(
    await screen.findByLabelText('Workflow JSON file'),
    new File([JSON.stringify(manifest)], 'workflow.json', {
      type: 'application/json',
    }),
  );
  await screen.findByLabelText('Complete imported graph');
  await event.type(
    screen.getByLabelText('New workflow name'),
    'Independent draft',
  );
  await event.click(screen.getByRole('button', { name: 'Preview import' }));
  await screen.findByText(/Compatible with this workspace/u);
}
