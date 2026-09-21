import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { WorkflowActions } from '@/features/workflow-publish/workflow-actions';
import { useWorkflowCommandSession } from '@/features/workflow-publish/use-workflow-command-session';
import { createEditorStore } from '@/features/workflow-editor/model/editor.store';
import { ApiError } from '@/lib/api/api-error';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const previewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const etag = `"draft-v1.${'a'.repeat(43)}"`;
const workspace = {
  id: workspaceId,
  name: 'Workspace',
  slug: 'workspace',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: ['workflow:read', 'workflow:update'],
  createdAt: '2026-09-15T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
} satisfies AccessibleWorkspace;

describe('node preview lifecycle', () => {
  it('resets input, validation, result, and acknowledgement when the node changes', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    const validation = new Promise((resolve) => {
      resolveValidation = resolve;
    });
    const apiClient = apiClientFor(() => validation);
    const store = editorStore();
    store.getState().selectNode('node-a');
    const event = userEvent.setup();
    const view = render(actions(store, apiClient));

    await event.click(screen.getByRole('button', { name: 'Preview node' }));
    fireEvent.change(screen.getByLabelText('Sample input (JSON)'), {
      target: { value: '{"a":1}' },
    });
    await event.click(screen.getByRole('checkbox'));
    await event.click(screen.getByRole('button', { name: 'Validate node' }));

    store.getState().selectNode('node-b');
    view.rerender(actions(store, apiClient));
    expect(screen.getByLabelText('Sample input (JSON)')).toHaveValue('{}');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.queryByText('Node valid')).not.toBeInTheDocument();

    await act(async () => {
      resolveValidation?.({
        mode: 'validate',
        valid: true,
        revision: 1,
        nodeId: 'node-a',
        issues: [],
        disclosure,
      });
      await Promise.resolve();
    });
    expect(screen.queryByText('Node valid')).not.toBeInTheDocument();
  });

  it('resumes observation of an accepted preview instead of executing again', async () => {
    let submissions = 0;
    let observations = 0;
    const apiClient = apiClientFor((request) => {
      if (request.path.includes('/draft/nodes/')) {
        submissions += 1;
        return Promise.resolve({
          mode: 'test_execute',
          replayed: false,
          preview: previewSummary('running'),
        });
      }
      observations += 1;
      if (observations === 1)
        return Promise.reject(
          new ApiError({ kind: 'network', message: 'stream unavailable' }),
        );
      return Promise.resolve({ preview: previewSummary('succeeded') });
    });
    const store = editorStore();
    store.getState().selectNode('node-a');
    render(actions(store, apiClient));
    const event = userEvent.setup();

    await event.click(screen.getByRole('button', { name: 'Preview node' }));
    await event.click(screen.getByRole('checkbox'));
    await event.click(screen.getByRole('button', { name: 'Test execute' }));
    expect(
      await screen.findByRole(
        'button',
        { name: 'Resume preview status' },
        {
          timeout: 2_500,
        },
      ),
    ).toBeVisible();
    expect(submissions).toBe(1);
    fireEvent.change(screen.getByLabelText('Sample input (JSON)'), {
      target: { value: '{\n}' },
    });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Resume preview status' }),
    ).toBeEnabled();

    await event.click(
      screen.getByRole('button', { name: 'Resume preview status' }),
    );
    await waitFor(
      () => {
        expect(screen.getByText(/succeeded/u)).toBeVisible();
      },
      { timeout: 2_500 },
    );
    expect(submissions).toBe(1);
    expect(observations).toBe(2);
  }, 7_000);
});

const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
} as const;

function previewSummary(status: 'running' | 'succeeded') {
  return {
    id: previewId,
    workspaceId,
    workflowId,
    draftRevision: 1,
    nodeId: 'node-a',
    status,
    disclosure,
    output: status === 'succeeded' ? { kind: 'inline', value: true } : null,
    safeErrorCode: null,
    createdAt: '2026-09-15T10:00:00.000Z',
    startedAt: '2026-09-15T10:00:01.000Z',
    completedAt: status === 'succeeded' ? '2026-09-15T10:00:02.000Z' : null,
    expiresAt: '2026-09-15T11:00:00.000Z',
  };
}

function editorStore() {
  return createEditorStore({
    graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    etag,
    revision: 1,
  });
}

function actions(store: ReturnType<typeof editorStore>, apiClient: ApiClient) {
  return <TestWorkflowActions store={store} apiClient={apiClient} />;
}

function TestWorkflowActions({
  store,
  apiClient,
}: Readonly<{
  store: ReturnType<typeof editorStore>;
  apiClient: ApiClient;
}>) {
  const ensureSaved = () =>
    Promise.resolve({
      etag: store.getState().etag,
      generation: store.getState().generation,
      revision: store.getState().revision,
    });
  const commandSession = useWorkflowCommandSession({
    apiClient,
    workspaceId,
    workflowId,
    verifyIdentity: () => Promise.resolve(),
    isSessionPaused: () => false,
    ensureSaved,
    onRunAccepted: vi.fn(),
  });

  return (
    <WorkflowActions
      apiClient={apiClient}
      userId={userId}
      workspace={workspace}
      workflowId={workflowId}
      selectedNodeId={store.getState().selectedNodeId}
      graph={store.getState().graph}
      generation={store.getState().generation}
      revision={store.getState().revision}
      commandSession={commandSession}
      ensureSaved={ensureSaved}
      onValidationTarget={vi.fn()}
    />
  );
}

function apiClientFor(
  request: (input: ApiJsonRequest<unknown>) => Promise<unknown>,
): ApiClient {
  return {
    request,
    stream: vi.fn(),
  } as unknown as ApiClient;
}
