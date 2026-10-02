import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { createApiClient } from '../../../src/lib/api/client';
import { WorkflowOrganizationManager } from '../../../src/features/workflows/components/organization/workflow-organization-manager';
import { WorkflowFolderPicker } from '../../../src/features/workflows/components/organization/workflow-folder-picker';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  api,
  userId,
  workflowId,
  secondWorkflowId,
  workspaceWith,
  discoveryHandlers,
  problem,
} from './workflow-list.fixtures';

const folder = {
  id: workflowId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
};
const tag = { id: secondWorkflowId, key: 'ops', revision: 3 };
const cursor = 'opaque.continuation';
function installVocabulary() {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflow-folders`, () =>
      HttpResponse.json({ items: [folder] }),
    ),
    http.get(`${api}/workflow-tags`, () =>
      HttpResponse.json({ items: [tag], nextCursor: null }),
    ),
  );
}
function renderManager(
  role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner',
) {
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
      <WorkflowOrganizationManager
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient, onClose };
}

describe('workflow organization manager', () => {
  it.each(['builder', 'viewer'] as const)(
    'does not mount admin reads or controls for %s',
    async (role) => {
      const read = vi.fn();
      mockServer.use(
        http.get(`${api}/workflow-folders`, () => {
          read();
          return HttpResponse.json({ items: [] });
        }),
      );
      renderManager(role);
      expect(screen.getByText(/Only owners and admins/)).toBeVisible();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(read).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    },
  );

  it('uses current folder revisions and normalized names without optimistic receipts', async () => {
    installVocabulary();
    const sent: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflow-folders`, async ({ request }) => {
        sent.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return HttpResponse.json({
          folder: { ...folder, name: 'Historical receipt' },
          replayed: true,
        });
      }),
    );
    renderManager();
    await screen.findByRole('button', { name: 'Edit folder Operations' });
    const event = userEvent.setup();
    await event.type(screen.getByLabelText('Folder name'), ' New team ');
    await event.click(screen.getByRole('button', { name: 'Create folder' }));
    await screen.findByText(/Command completed/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ name: 'New team', parentId: null });
    expect(typeof sent[0]?.key).toBe('string');
    expect(
      screen.queryByRole('button', { name: 'Edit folder Historical receipt' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Edit folder Operations' }),
    ).toBeVisible();
  });

  it('shows folder not-empty conflict and keeps the draft until an explicit reload', async () => {
    installVocabulary();
    mockServer.use(
      http.post(`${api}/workflow-folders/${workflowId}/delete`, () =>
        problem(409, 'workflow.folder_not_empty'),
      ),
    );
    renderManager();
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Edit folder Operations' }),
    );
    await event.click(screen.getByRole('button', { name: 'Delete folder' }));
    await event.click(
      screen.getByRole('button', { name: 'Confirm delete folder' }),
    );
    await screen.findByText(
      'Move the workflows and child folders out before deleting this folder.',
    );
    expect(screen.getByLabelText('Folder name')).toHaveValue('Operations');
    expect(
      screen.getByRole('button', { name: 'Reload current folders and tags' }),
    ).toBeEnabled();
  });

  it('locks uncertain forms and retries the same revision, body and key', async () => {
    installVocabulary();
    const sent: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(
        `${api}/workflow-folders/${workflowId}/rename`,
        async ({ request }) => {
          sent.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          return sent.length === 1
            ? HttpResponse.error()
            : HttpResponse.json({
                folder: { ...folder, name: 'New operations', revision: 3 },
                replayed: true,
              });
        },
      ),
    );
    const { onClose } = renderManager();
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Edit folder Operations' }),
    );
    await event.clear(screen.getByLabelText('Folder name'));
    await event.type(screen.getByLabelText('Folder name'), 'New operations');
    await event.click(screen.getByRole('button', { name: 'Rename folder' }));
    const retry = await screen.findByRole('button', {
      name: 'Retry exact command',
    });
    expect(screen.getByLabelText('Folder name')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Close manager' }),
    ).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await event.click(retry);
    await screen.findByText(/Command completed/);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]?.body).toEqual({
      name: 'New operations',
      expectedFolderRevision: 2,
    });
  });

  it('hides cached vocabulary controls on denied writes and still allows closing', async () => {
    installVocabulary();
    mockServer.use(
      http.post(`${api}/workflow-tags/${secondWorkflowId}/rename`, () =>
        problem(403, 'request.forbidden'),
      ),
    );
    const { onClose } = renderManager();
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Edit tag ops' }),
    );
    await event.click(screen.getByRole('button', { name: 'Rename tag' }));
    await screen.findByText(/Organization controls are closed/);
    expect(
      screen.queryByRole('button', { name: 'Edit folder Operations' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tag key')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry exact command' }),
    ).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Close manager' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers bounded cleanup after overflow and retains exact ordered selection on retry', async () => {
    installVocabulary();
    const assignmentReads = vi.fn();
    const sent: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflow-tags/${secondWorkflowId}/delete`, () =>
        problem(409, 'workflow.tag_delete_overflow'),
      ),
      http.get(
        `${api}/workflow-tags/${secondWorkflowId}/workflows`,
        ({ request }) => {
          assignmentReads();
          const after = new URL(request.url).searchParams.get('after');
          return HttpResponse.json(
            after === null
              ? {
                  items: [{ workflowId, organizationRevision: 7 }],
                  nextCursor: cursor,
                }
              : {
                  items: [
                    { workflowId: secondWorkflowId, organizationRevision: 9 },
                  ],
                  nextCursor: null,
                },
          );
        },
      ),
      http.post(`${api}/workflow-tags/cleanup/detach`, async ({ request }) => {
        sent.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return HttpResponse.json({
          items: [
            {
              workflowId: secondWorkflowId,
              status: 'detached',
              organizationRevision: 10,
              replayed: true,
            },
            {
              workflowId,
              status: sent.length === 1 ? 'outcome_unknown' : 'not_visible',
            },
          ],
        });
      }),
    );
    renderManager();
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Edit tag ops' }),
    );
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    await event.click(
      screen.getByRole('button', { name: 'Confirm delete tag' }),
    );
    await screen.findByText(/too many assignments/);
    await event.click(
      screen.getByRole('button', { name: 'Review tag assignments' }),
    );
    await screen.findByRole('checkbox', {
      name: `Select workflow ${workflowId}`,
    });
    expect(assignmentReads).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('checkbox', { name: /Select all/ }),
    ).not.toBeInTheDocument();
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    await event.click(
      await screen.findByRole('checkbox', {
        name: `Select workflow ${secondWorkflowId}`,
      }),
    );
    await event.click(
      screen.getByRole('checkbox', { name: `Select workflow ${workflowId}` }),
    );
    await event.click(
      screen.getByRole('button', {
        name: 'Detach tag from 2 selected workflows',
      }),
    );
    await screen.findByRole('button', { name: 'Retry exact command' });
    expect(
      screen.getByRole('checkbox', { name: `Select workflow ${workflowId}` }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(sent[0]?.body).toEqual({
      tagId: secondWorkflowId,
      items: [
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 9 },
        { workflowId, expectedOrganizationRevision: 7 },
      ],
    });
    expect(
      within(screen.getByRole('region', { name: 'Tag cleanup' })).getByRole(
        'button',
        { name: 'Back to tags' },
      ),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', { name: 'Retry exact command' }),
    );
    await waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]).toEqual(sent[0]);
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry exact command' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 2 selected workflows',
      }),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', {
        name: 'Reload assignments and clear selection',
      }),
    );
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 0 selected workflows',
      }),
    ).toBeDisabled();
  });

  it('labels bounded folder ancestry and maps the root sentinel to null', async () => {
    const change = vi.fn();
    render(
      <WorkflowFolderPicker
        folders={[
          folder,
          {
            ...folder,
            id: secondWorkflowId,
            name: 'Child',
            parentId: folder.id,
            depth: 2,
          },
        ]}
        value={secondWorkflowId}
        onChange={change}
      />,
    );
    const picker = screen.getByRole('combobox', { name: 'Folder' });
    expect(picker).toHaveTextContent('Operations / Child');
    const event = userEvent.setup();
    picker.focus();
    await event.keyboard('{ArrowDown}');
    await event.click(
      await screen.findByRole('option', { name: 'Unfiled / top level' }),
    );
    expect(change).toHaveBeenCalledWith(null);
  });

  it('loads assignment pages only on request and caps explicit selection at 50', async () => {
    installVocabulary();
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        `${(index + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const reads = vi.fn();
    mockServer.use(
      http.get(
        `${api}/workflow-tags/${secondWorkflowId}/workflows`,
        ({ request }) => {
          const after = new URL(request.url).searchParams.get('after');
          reads();
          const start = after === null ? 0 : after === cursor ? 25 : 50;
          return HttpResponse.json({
            items: ids
              .slice(start, start + 25)
              .map((id) => ({ workflowId: id, organizationRevision: 1 })),
            nextCursor:
              start === 0 ? cursor : start === 25 ? 'opaque.page2' : null,
          });
        },
      ),
    );
    renderManager();
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Edit tag ops' }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Review tag assignments' }),
    );
    const first = ids[0];
    const secondPage = ids[25];
    const last = ids[50];
    if (first === undefined || secondPage === undefined || last === undefined)
      throw new Error('Expected three fixture pages');
    await screen.findByRole('checkbox', { name: `Select workflow ${first}` });
    expect(reads).toHaveBeenCalledTimes(1);
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    await screen.findByRole('checkbox', {
      name: `Select workflow ${secondPage}`,
    });
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    await screen.findByRole('checkbox', { name: `Select workflow ${last}` });
    for (const id of ids.slice(0, 50))
      await event.click(
        screen.getByRole('checkbox', { name: `Select workflow ${id}` }),
      );
    expect(
      screen.getByRole('checkbox', { name: `Select workflow ${last}` }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 50 selected workflows',
      }),
    ).toBeEnabled();
    expect(reads).toHaveBeenCalledTimes(3);
  });
});
