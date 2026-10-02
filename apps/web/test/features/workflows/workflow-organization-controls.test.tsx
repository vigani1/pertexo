import { render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowOrganizationProjectionResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { WorkflowOrganizationDialog } from '@/features/workflows/components/organization/workflow-organization-dialog';
import {
  WorkflowFavoriteButton,
  WorkflowFavoriteDialog,
} from '@/features/workflows/components/organization/workflow-favorite-button';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowOrganizationProjectionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  api,
  userId,
  workflowId,
  secondWorkflowId,
  workspaceWith,
  summary,
  discoveryHandlers,
  problem,
} from './workflow-list.fixtures';

const tag = { id: secondWorkflowId, key: 'attached-outside-page', revision: 1 };
function projection(id = workflowId, revision = 1, archived = false) {
  return workflowOrganizationProjectionResponseSchema.parse({
    workflow: summary(
      id,
      id === workflowId ? 'First workflow' : 'Second workflow',
      { lifecycleStatus: archived ? 'archived' : 'active' },
    ),
    organization: {
      tags: [tag],
      folderId: null,
      organizationRevision: revision,
      isFavorite: true,
      favoriteRevision: workflowId,
    },
  });
}
function FavoriteHarness({
  apiClient,
  workspace,
  workflow,
  hideTrigger,
  onClose,
}: {
  apiClient: ApiClient;
  workspace: AccessibleWorkspace;
  workflow: WorkflowOrganizationProjectionResponse;
  hideTrigger: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {hideTrigger ? null : (
        <WorkflowFavoriteButton
          workspace={workspace}
          workflow={workflow}
          onOpen={() => {
            setOpen(true);
          }}
        />
      )}
      {open ? (
        <WorkflowFavoriteDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={workflow}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
function setup({
  role = 'owner',
  archived = false,
  multiple = false,
  favorite = false,
}: {
  role?: 'owner' | 'admin' | 'builder' | 'viewer';
  archived?: boolean;
  multiple?: boolean;
  favorite?: boolean;
} = {}) {
  const workspace = accessibleWorkspaceSchema.parse({
    ...workspaceWith(role === 'viewer' ? [] : ['workflow:update']),
    role,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
  const selected = multiple
    ? [projection(secondWorkflowId), projection()]
    : [projection(workflowId, 1, archived)];
  const onClose = vi.fn();
  mockServer.use(
    ...discoveryHandlers(role === 'viewer' ? [] : ['workflow:update']),
    http.get(`${api}/workflow-folders`, () => HttpResponse.json({ items: [] })),
    http.get(`${api}/workflow-tags`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${api}/workflows/:id`, ({ params }) =>
      HttpResponse.json(projection(String(params.id), 9, archived)),
    ),
  );
  const tree = (hideTrigger = false) => (
    <QueryClientProvider client={client}>
      {favorite ? (
        <FavoriteHarness
          apiClient={apiClient}
          workspace={workspace}
          workflow={selected[0] ?? projection()}
          hideTrigger={hideTrigger}
          onClose={onClose}
        />
      ) : (
        <WorkflowOrganizationDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflows={selected}
          onClose={onClose}
        />
      )}
    </QueryClientProvider>
  );
  const rendered = render(tree());
  return {
    ...rendered,
    client,
    onClose,
    removeFavoriteRow: () => {
      rendered.rerender(tree(true));
    },
  };
}
describe('organization editing controls', () => {
  it('keeps exact favorite recovery in a separate owner after the trigger row disappears', async () => {
    const captures: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/favorite`,
        async ({ request }) => {
          captures.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          return captures.length === 1
            ? HttpResponse.error()
            : HttpResponse.json({
                isFavorite: false,
                favoriteRevision: secondWorkflowId,
                replayed: true,
              });
        },
      ),
    );
    const { removeFavoriteRow, onClose } = setup({ favorite: true });
    expect(
      screen.getByRole('button', {
        name: 'Manage favorite for First workflow',
      }),
    ).toHaveTextContent('Remove favorite');
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Manage favorite for First workflow',
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove favorite' }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove favorite' }),
    );
    await screen.findByRole('button', { name: 'Retry original request' });
    removeFavoriteRow();
    expect(
      screen.queryByRole('button', {
        name: 'Manage favorite for First workflow',
        hidden: true,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: 'Personal favorite' }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh current state' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry original request' }),
      ).toBeEnabled(),
    );
    expect(captures).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'Remove favorite', exact: true }),
    ).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry original request' }),
    );
    await screen.findByText(/Favorite command accepted/);
    expect(captures).toHaveLength(2);
    expect(captures[1]).toEqual(captures[0]);
  });
  it('does not expose editing fields to a viewer', async () => {
    setup({ role: 'viewer' });
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: 'Move selected workflows' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Selected workflows' }),
    ).not.toBeInTheDocument();
  });
  it('retains the explicit tag draft after an idempotency conflict until fresh intent is requested', async () => {
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/tags`, () =>
        problem(409, 'request.idempotency_conflict'),
      ),
    );
    setup();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move selected workflows' }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Replace tags' }));
    await userEvent.click(screen.getByRole('checkbox', { name: tag.key }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Replace selected tags' }),
    );
    await screen.findByText(/different input/);
    expect(screen.getByRole('checkbox', { name: tag.key })).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Replace selected tags' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Retry original request' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh for a new change' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move selected workflows' }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Replace tags' }));
    expect(screen.getByRole('checkbox', { name: tag.key })).toBeChecked();
  });
  it('presents ordered access-loss outcomes without retained workflow names or retry controls', async () => {
    mockServer.use(
      http.post(`${api}/workflows/organization/bulk`, () =>
        HttpResponse.json({
          items: [
            { workflowId: secondWorkflowId, status: 'forbidden' },
            { workflowId, status: 'not_processed' },
          ],
        }),
      ),
    );
    setup({ multiple: true });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move selected workflows' }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Move selected workflows' }),
    );
    await screen.findByText('Access lost — processing stopped');
    expect(screen.getByText('Not processed after access loss')).toBeVisible();
    expect(screen.queryByText('First workflow')).not.toBeInTheDocument();
    expect(screen.queryByText('Second workflow')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry original request' }),
    ).not.toBeInTheDocument();
  });
  it('checks current projection before capturing a single placement revision', async () => {
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/folder`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({
            workflowId,
            folderId: null,
            organizationRevision: 10,
            replayed: false,
          });
        },
      ),
    );
    setup();
    const submit = await screen.findByRole('button', {
      name: 'Move selected workflows',
    });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(
      within(
        screen.getByRole('list', { name: 'Selected workflows' }),
      ).getByText('First workflow'),
    ).toBeVisible();
    await userEvent.click(submit);
    await screen.findByText(/Organization command accepted/);
    expect(bodies).toEqual([
      { folderId: null, expectedOrganizationRevision: 9 },
    ]);
  });
  it('retains attached tags outside loaded vocabulary and explicitly replaces them', async () => {
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/tags`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          workflowId,
          organizationRevision: 10,
          replayed: false,
        });
      }),
    );
    setup();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move selected workflows' }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Replace tags' }));
    const checkbox = screen.getByRole('checkbox', { name: tag.key });
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);
    await userEvent.click(
      screen.getByRole('button', { name: 'Replace selected tags' }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([{ tagIds: [], expectedOrganizationRevision: 9 }]);
    });
  });
  it('shows ordered partial results and retries the same entire parent key and body', async () => {
    const captures: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/organization/bulk`, async ({ request }) => {
        captures.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        return HttpResponse.json({
          items: [
            {
              workflowId: secondWorkflowId,
              status: 'updated',
              organizationRevision: 10,
              replayed: captures.length > 1,
            },
            { workflowId, status: 'outcome_unknown' },
          ],
        });
      }),
    );
    const { onClose } = setup({ multiple: true });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move selected workflows' }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Move selected workflows' }),
    );
    await screen.findByRole('button', { name: 'Retry original request' });
    const outcomes = within(
      screen.getByRole('region', { name: 'Organization command outcomes' }),
    ).getAllByRole('listitem');
    expect(outcomes[0]).toHaveTextContent('Second workflow');
    expect(outcomes[1]).toHaveTextContent('First workflow');
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh current state' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry original request' }),
      ).toBeEnabled(),
    );
    expect(captures).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Move selected workflows' }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry original request' }),
    );
    await waitFor(() => {
      expect(captures).toHaveLength(2);
    });
    expect(captures[1]).toEqual(captures[0]);
    expect(captures[0]?.body).toEqual({
      operation: 'move',
      folderId: null,
      items: [
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 9 },
        { workflowId, expectedOrganizationRevision: 9 },
      ],
    });
    expect(
      screen.getByText(/Exact recovery is available for 24 hours/),
    ).toBeVisible();
  });
  it.each(['builder'] as const)(
    'blocks archived placement for %s',
    async (role) => {
      setup({ role, archived: true });
      expect(
        await screen.findByRole('button', { name: 'Move selected workflows' }),
      ).toBeDisabled();
    },
  );
  it('allows admin archived placement but not general archived tag replacement', async () => {
    setup({ role: 'admin', archived: true });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move selected workflows' }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Replace tags' }));
    expect(
      screen.getByRole('button', { name: 'Replace selected tags' }),
    ).toBeDisabled();
  });
  it('allows a viewer to set a personal favorite on an archived workflow with the current token', async () => {
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/favorite`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({
            isFavorite: false,
            favoriteRevision: secondWorkflowId,
            replayed: false,
          });
        },
      ),
    );
    setup({ role: 'viewer', archived: true, favorite: true });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Manage favorite for First workflow',
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove favorite' }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove favorite' }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([
        { favorite: false, expectedFavoriteRevision: workflowId },
      ]);
    });
    await screen.findByText(/Favorite command accepted/);
  });
  it('captures the fresh bounded absence token for an explicit desired favorite', async () => {
    const captures: unknown[] = [];
    setup({ favorite: true, role: 'viewer' });
    let reads = 0;
    const token = (issued: number) =>
      `absent.v1.${String(issued)}.${String(issued + 86400)}.${'a'.repeat(42)}A`;
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}`, () => {
        reads += 1;
        const current = projection();
        return HttpResponse.json({
          ...current,
          organization: {
            ...current.organization,
            isFavorite: false,
            favoriteRevision: token(reads),
          },
        });
      }),
      http.post(
        `${api}/workflows/${workflowId}/favorite`,
        async ({ request }) => {
          captures.push(await request.json());
          return HttpResponse.json({
            isFavorite: true,
            favoriteRevision: secondWorkflowId,
            replayed: false,
          });
        },
      ),
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Manage favorite for First workflow',
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add favorite' }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add favorite' }));
    await screen.findByText(/Favorite command accepted/);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(captures).toEqual([
      { favorite: true, expectedFavoriteRevision: token(2) },
    ]);
  });
});
