import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import type { Role } from '@pertexo/workflow-model';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { vi } from 'vitest';
import { NotificationsProvider } from '../../../../../src/components/ui/toast';
import { WorkflowTagsDialog } from '../../../../../src/features/workflows/components/organization/tags/dialog';
import { createApiClient } from '../../../../../src/lib/api/client';
import { mockServer } from '../../../../support/mock-server';
import { testFetch } from '../../../../support/render-app';
import {
  api,
  discoveryHandlers,
  secondWorkflowId,
  summary,
  userId,
  workflowId,
  workspaceWith,
} from '../../list/fixtures';
const folder = {
  id: workflowId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
};

export const tag = { id: secondWorkflowId, key: 'ops', revision: 3 };

export const cursor = 'opaque-continuation';

export function installVocabulary() {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflow-folders`, () =>
      HttpResponse.json({ items: [folder] }),
    ),
    http.get(`${api}/workflow-tags`, () =>
      HttpResponse.json({ items: [tag], nextCursor: null }),
    ),
    http.get(`${api}/workflows/:id`, ({ params }) =>
      HttpResponse.json({
        workflow: summary(
          String(params.id),
          params.id === workflowId ? 'Alpha' : 'Beta',
        ),
        organization: {
          tags: [],
          folderId: null,
          organizationRevision: 1,
          isFavorite: true,
        },
      }),
    ),
  );
}

export function renderTags(role: Role = 'owner') {
  const workspace = accessibleWorkspaceSchema.parse({
    ...workspaceWith(['workflow:read', 'workflow:update']),
    role,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
  const onClose = vi.fn();
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <WorkflowTagsDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          onClose={onClose}
        />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient, onClose };
}
