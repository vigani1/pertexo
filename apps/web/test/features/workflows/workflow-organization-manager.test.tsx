import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { createApiClient } from '../../../src/lib/api/client';
import { WorkflowOrganizationManager } from '../../../src/features/workflows/components/organization/workflow-organization-manager';
import { WorkflowFolderPicker } from '../../../src/features/workflows/components/organization/workflow-folder-picker';
import { workflowOrganizationKeys } from '@/features/workflows/data/organization.queries';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  api,
  userId,
  workspaceId,
  workflowId,
  secondWorkflowId,
  workspaceWith,
  discoveryHandlers,
  problem,
  summary,
} from './workflow-list.fixtures';

const folder = {
  id: workflowId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
};
const tag = { id: secondWorkflowId, key: 'ops', revision: 3 };
const cursor = 'opaque-continuation';
function installVocabulary() {
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
  it.each(['folder', 'tag'] as const)(
    'does not inherit a completed create command in a new %s deletion confirmation',
    async (kind) => {
      installVocabulary();
      const deleted = vi.fn();
      const id = kind === 'folder' ? folder.id : tag.id;
      const name = kind === 'folder' ? folder.name : tag.key;
      mockServer.use(
        http.post(`${api}/workflow-${kind}s`, () =>
          HttpResponse.json(
            kind === 'folder'
              ? { folder, replayed: false }
              : { tag, replayed: false },
          ),
        ),
        http.post(`${api}/workflow-${kind}s/${id}/delete`, () => {
          deleted();
          return HttpResponse.json({ deleted: true, replayed: false });
        }),
      );
      renderManager();
      const event = userEvent.setup();
      await screen.findByRole('button', { name: `Edit ${kind} ${name}` });
      await event.type(
        screen.getByLabelText(kind === 'folder' ? 'Folder name' : 'Tag key'),
        kind === 'folder' ? 'New folder' : 'new-tag',
      );
      await event.click(screen.getByRole('button', { name: `Create ${kind}` }));
      await screen.findByText(/Command completed/);
      await event.click(
        screen.getByRole('button', { name: `Edit ${kind} ${name}` }),
      );
      await event.click(screen.getByRole('button', { name: `Delete ${kind}` }));
      const confirmation = screen.getByRole('dialog', {
        name: `Delete ${name}?`,
      });
      expect(
        within(confirmation).queryByText(/Command completed/),
      ).not.toBeInTheDocument();
      const confirm = within(confirmation).getByRole('button', {
        name: `Confirm delete ${kind}`,
      });
      expect(confirm).toBeEnabled();
      expect(deleted).not.toHaveBeenCalled();
      await event.click(confirm);
      await waitFor(() => {
        expect(deleted).toHaveBeenCalledTimes(1);
      });
    },
  );
  it.each(['folder', 'tag'] as const)(
    'binds %s deletion to the displayed snapshot across a background rename',
    async (kind) => {
      installVocabulary();
      let renamed = false;
      const nextFolder = { ...folder, name: 'Renamed operations', revision: 8 };
      const nextTag = { ...tag, key: 'renamed-ops', revision: 9 };
      const id = kind === 'folder' ? folder.id : tag.id;
      const originalName = kind === 'folder' ? folder.name : tag.key;
      const nextName = kind === 'folder' ? nextFolder.name : nextTag.key;
      const bodies: unknown[] = [];
      mockServer.use(
        http.get(`${api}/workflow-folders`, () =>
          HttpResponse.json({ items: [renamed ? nextFolder : folder] }),
        ),
        http.get(`${api}/workflow-tags`, () =>
          HttpResponse.json({
            items: [renamed ? nextTag : tag],
            nextCursor: null,
          }),
        ),
        http.post(
          `${api}/workflow-${kind}s/${id}/delete`,
          async ({ request }) => {
            bodies.push(await request.json());
            return problem(409, `workflow.${kind}_revision_conflict`);
          },
        ),
      );
      const { queryClient } = renderManager();
      await userEvent.click(
        await screen.findByRole('button', {
          name: `Edit ${kind} ${originalName}`,
        }),
      );
      await userEvent.click(
        screen.getByRole('button', { name: `Delete ${kind}` }),
      );
      renamed = true;
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey:
            kind === 'folder'
              ? workflowOrganizationKeys.folders(userId, workspaceId)
              : workflowOrganizationKeys.tags(userId, workspaceId),
        });
      });
      expect(
        screen.getByRole('dialog', { name: `Delete ${originalName}?` }),
      ).toBeVisible();
      expect(
        screen.queryByRole('dialog', { name: `Delete ${nextName}?` }),
      ).not.toBeInTheDocument();
      const confirm = screen.getByRole('button', {
        name: `Confirm delete ${kind}`,
      });
      await waitFor(() => expect(confirm).toBeEnabled());
      await userEvent.click(confirm);
      await screen.findByText(
        `This ${kind} changed. Refresh it before trying again.`,
      );
      expect(bodies).toEqual([
        kind === 'folder'
          ? { expectedFolderRevision: folder.revision }
          : { expectedTagRevision: tag.revision },
      ]);
      expect(confirm).toBeDisabled();
      expect(
        screen.getByRole('dialog', { name: `Delete ${originalName}?` }),
      ).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Retry exact command' }),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await userEvent.click(
        screen.getByRole('button', { name: 'Reload current folders and tags' }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: `Edit ${kind} ${nextName}` }),
      );
      await userEvent.click(
        screen.getByRole('button', { name: `Delete ${kind}` }),
      );
      expect(
        screen.getByRole('dialog', { name: `Delete ${nextName}?` }),
      ).toBeVisible();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: `Confirm delete ${kind}` }),
        ).toBeEnabled(),
      );
      await userEvent.click(
        screen.getByRole('button', { name: `Confirm delete ${kind}` }),
      );
      await waitFor(() => {
        expect(bodies).toHaveLength(2);
      });
      expect(bodies[1]).toEqual(
        kind === 'folder'
          ? { expectedFolderRevision: nextFolder.revision }
          : { expectedTagRevision: nextTag.revision },
      );
    },
  );
  it.each([
    {
      label: 'Folder name',
      action: 'Create folder',
      value: 'é'.repeat(65),
      message: /1–128 UTF-8/,
    },
    {
      label: 'Tag key',
      action: 'Create tag',
      value: 'bad.key',
      message: /1–32 bytes/,
    },
  ])(
    'associates $label validation and focuses the invalid field only on submit',
    async ({ label, action, value, message }) => {
      installVocabulary();
      renderManager();
      await screen.findByRole('button', { name: 'Edit folder Operations' });
      const field = screen.getByLabelText(label);
      await userEvent.type(field, value);
      expect(field).not.toHaveAttribute('aria-invalid', 'true');
      await userEvent.click(screen.getByRole('button', { name: action }));
      expect(field).toHaveFocus();
      expect(field).toHaveAttribute('aria-invalid', 'true');
      const error = screen.getByText(message);
      expect(field.getAttribute('aria-describedby')).toContain(error.id);
      await userEvent.clear(field);
      await userEvent.type(field, 'valid');
      expect(field).not.toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    },
  );
  it('shows real pending progress for the submitted folder command', async () => {
    installVocabulary();
    let release: (() => void) | undefined;
    mockServer.use(
      http.post(`${api}/workflow-folders`, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ folder, replayed: false });
      }),
    );
    renderManager();
    await screen.findByRole('button', { name: 'Edit folder Operations' });
    await userEvent.type(screen.getByLabelText('Folder name'), 'New folder');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create folder' }),
    );
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toHaveAttribute('data-pending');
    expect(saving).toBeDisabled();
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    await screen.findByText(/Command completed/);
  });
  it('uses a cancellable canonical destructive confirmation without sending on open', async () => {
    installVocabulary();
    const sent = vi.fn();
    mockServer.use(
      http.post(`${api}/workflow-folders/${workflowId}/delete`, () => {
        sent();
        return HttpResponse.json({ deleted: true, replayed: false });
      }),
    );
    renderManager();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit folder Operations' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete folder' }),
    );
    const confirmation = screen.getByRole('dialog', {
      name: 'Delete Operations?',
    });
    expect(
      within(confirmation).getByRole('button', {
        name: 'Confirm delete folder',
      }),
    ).toBeEnabled();
    expect(sent).not.toHaveBeenCalled();
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Delete Operations?' }),
    ).not.toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
  });
  it('uses an unavailable ordinal instead of leaking IDs or stale names for an invisible assignment', async () => {
    installVocabulary();
    mockServer.use(
      http.get(`${api}/workflow-tags/${secondWorkflowId}/workflows`, () =>
        HttpResponse.json({
          items: [{ workflowId, organizationRevision: 7 }],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/workflows/${workflowId}`, () =>
        problem(404, 'workflow.not_found'),
      ),
    );
    const { queryClient } = renderManager();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit tag ops' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Review tag assignments' }),
    );
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Select workflow name unavailable (1)',
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData([
          'identity',
          userId,
          'workspace',
          workspaceId,
          'workflow-organization',
          'labels',
          workflowId,
        ]),
      ).toBeNull();
    });
    expect(checkbox).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByText(workflowId, { exact: false }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });
  it('retires cleanup controls and names when a projection name read loses permission', async () => {
    installVocabulary();
    mockServer.use(
      http.get(`${api}/workflow-tags/${secondWorkflowId}/workflows`, () =>
        HttpResponse.json({
          items: [{ workflowId, organizationRevision: 7 }],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/workflows/${workflowId}`, () =>
        problem(403, 'request.forbidden'),
      ),
    );
    renderManager();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit tag ops' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Review tag assignments' }),
    );
    await screen.findByText(/Organization controls are closed/);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(
      screen.queryByText(workflowId, { exact: false }),
    ).not.toBeInTheDocument();
  });
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
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
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
    expect(
      screen.getByText(
        /Deletion also removes assignments from archived workflows\./,
      ),
    ).toBeInTheDocument();
    await event.click(
      screen.getByRole('button', { name: 'Confirm delete tag' }),
    );
    await screen.findByText(/too many assignments/);
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(
      screen.getByRole('button', { name: 'Review tag assignments' }),
    );
    await screen.findByRole('checkbox', {
      name: 'Select Alpha',
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
        name: 'Select Beta',
      }),
    );
    await event.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await event.click(
      screen.getByRole('button', {
        name: 'Detach tag from 2 selected workflows',
      }),
    );
    await screen.findByRole('button', { name: 'Retry exact command' });
    expect(
      screen.getByRole('checkbox', { name: 'Select Alpha' }),
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
      http.get(`${api}/workflows/:id`, ({ params }) => {
        const index = ids.indexOf(String(params.id));
        return HttpResponse.json({
          workflow: summary(String(params.id), `Workflow ${String(index + 1)}`),
          organization: {
            tags: [],
            folderId: null,
            organizationRevision: 1,
            isFavorite: true,
          },
        });
      }),
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
              start === 0 ? cursor : start === 25 ? 'opaque-page2' : null,
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
    await screen.findByRole('checkbox', { name: 'Select Workflow 1' });
    expect(reads).toHaveBeenCalledTimes(1);
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    await screen.findByRole('checkbox', {
      name: 'Select Workflow 26',
    });
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    const overflow = await screen.findByRole('checkbox', {
      name: 'Select workflow name unavailable (51)',
    });
    // Wait for all bounded name reads once. These keyed controls stay mounted
    // during selection; rescanning the whole accessibility tree per click adds
    // avoidable quadratic work when the complete suite competes for CPU.
    const checkboxes = await waitFor(() => {
      const controls = screen.getAllByRole('checkbox', {
        name: /^Select Workflow \d+$/,
      });
      expect(controls).toHaveLength(50);
      return controls;
    });
    for (const [index, checkbox] of checkboxes.entries()) {
      expect(checkbox).toHaveAccessibleName(
        `Select Workflow ${String(index + 1)}`,
      );
      await event.click(checkbox);
      expect(checkbox).toBeChecked();
    }
    expect(overflow).toHaveAttribute('aria-disabled', 'true');
    await event.click(overflow);
    expect(overflow).not.toBeChecked();
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 50 selected workflows',
      }),
    ).toBeEnabled();
    expect(reads).toHaveBeenCalledTimes(3);
  });
});
