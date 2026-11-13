import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { HumanFormSetup } from '@/features/workflow-editor/components/inspector/human-task/setup';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';

// product-ux-11: what a waiting approval costs, in plain words.
it('says in plain words what waiting for a person holds and what still applies', async () => {
  mockServer.use(
    http.get('*', () => HttpResponse.json({ items: [], nextCursor: null })),
  );
  const node: WorkflowNode = {
    id: 'review',
    definition: { key: 'core.approval', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
  render(
    <QueryClientProvider client={createQueryClient()}>
      <HumanFormSetup
        node={node}
        graph={{ nodes: [node], edges: [] }}
        definitionKey="core.approval"
        form={{
          nodeId: 'review',
          editable: true,
          reportScratch: vi.fn(),
          commit: vi.fn(),
        }}
        scope={{
          apiClient: createApiClient({
            fetch: testFetch,
            readCsrfToken: () => 'csrf-token-for-component-tests-1234567890',
          }),
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        }}
      />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(
      /While it waits for a person, the run doesn’t hold a run slot or use up its time limit\. A deadline you set still applies\./u,
    ),
  ).toBeVisible();
  expect(screen.queryByText(/active slot|execution budget/u)).toBeNull();
});
