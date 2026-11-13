import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { HumanFormSetup } from '@/features/workflow-editor/components/inspector/human-task/setup';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';

function renderForm(config: WorkflowNode['config']) {
  mockServer.use(
    http.get('*', () => HttpResponse.json({ items: [], nextCursor: null })),
  );
  const node: WorkflowNode = {
    id: 'intake',
    definition: { key: 'core.form', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config,
    inputMappings: {},
    connectionRefs: {},
  };
  render(
    <QueryClientProvider client={createQueryClient()}>
      <HumanFormSetup
        node={node}
        graph={{ nodes: [node], edges: [] }}
        definitionKey="core.form"
        form={{
          nodeId: 'intake',
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
}

// product-ux-17: a new form shows what it needs; coordination waits folded.
describe('event coordination on a form', () => {
  it('is folded away, with no coordinated-event history, until it is used', async () => {
    renderForm({});
    expect(await screen.findByText('Event coordination · Off')).toBeVisible();
    expect(screen.getByLabelText('Policy')).not.toBeVisible();
    expect(screen.queryByText(/Coordinated form events/u)).toBeNull();
  });

  it('opens by itself when the form already coordinates its events', async () => {
    renderForm({
      coordination: {
        mode: 'deduplicate',
        key: { kind: 'run_input', path: '$.message' },
        windowSeconds: 86_400,
      },
    });
    expect(await screen.findByText('Event coordination · On')).toBeVisible();
    expect(screen.getByLabelText('Policy')).toBeVisible();
  });
});
