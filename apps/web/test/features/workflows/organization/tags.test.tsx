import type { Role } from '@pertexo/workflow-model';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { createApiClient } from '../../../../src/lib/api/client';
import { WorkflowTagsDialog } from '../../../../src/features/workflows/components/organization/tags/dialog';
import { NotificationsProvider } from '../../../../src/components/ui/toast';
import { workflowOrganizationKeys } from '@/features/workflows/data/organization/queries';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
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
} from '../list/fixtures';

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
function renderTags(role: Role = 'owner') {
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

describe('workflow tags dialog', () => {
  it('lets a completed add tag stay out of a later deletion confirmation', async () => {
    installVocabulary();
    const deleted = vi.fn();
    mockServer.use(
      http.post(`${api}/workflow-tags`, () =>
        HttpResponse.json({ tag, replayed: false }),
      ),
      http.post(`${api}/workflow-tags/${tag.id}/delete`, () => {
        deleted();
        return HttpResponse.json({ deleted: true, replayed: false });
      }),
    );
    renderTags();
    const event = userEvent.setup();
    await screen.findByRole('button', { name: 'ops' });
    await event.type(screen.getByLabelText('New tag'), 'new-tag');
    await event.click(screen.getByRole('button', { name: 'Add tag' }));
    await screen.findByText('Tag added');
    await event.click(screen.getByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    const confirmation = screen.getByRole('dialog', { name: 'Delete #ops?' });
    const confirm = within(confirmation).getByRole('button', {
      name: 'Delete tag',
    });
    expect(confirm).toBeEnabled();
    expect(deleted).not.toHaveBeenCalled();
    await event.click(confirm);
    await waitFor(() => {
      expect(deleted).toHaveBeenCalledTimes(1);
    });
  });
  it('binds deletion to the tag as shown across a background rename, then reloads explicitly', async () => {
    installVocabulary();
    let renamed = false;
    const nextTag = { ...tag, key: 'renamed-ops', revision: 9 };
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${api}/workflow-tags`, () =>
        HttpResponse.json({
          items: [renamed ? nextTag : tag],
          nextCursor: null,
        }),
      ),
      http.post(
        `${api}/workflow-tags/${tag.id}/delete`,
        async ({ request }) => {
          bodies.push(await request.json());
          return bodies.length === 1
            ? problem(409, 'workflow.tag_revision_conflict')
            : HttpResponse.json({ deleted: true, replayed: false });
        },
      ),
    );
    const { queryClient } = renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    renamed = true;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.tags(userId, workspaceId),
      });
    });
    const confirmation = screen.getByRole('dialog', { name: 'Delete #ops?' });
    await event.click(
      within(confirmation).getByRole('button', { name: 'Delete tag' }),
    );
    await screen.findAllByText(
      'This tag changed. Refresh it before trying again.',
    );
    expect(bodies).toEqual([{ expectedTagRevision: tag.revision }]);
    await event.click(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    );
    await event.click(screen.getByRole('button', { name: 'Reload tags' }));
    // The same tag stays chosen, now with its current name.
    expect(await screen.findByLabelText('Rename #renamed-ops')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    await event.click(
      within(
        screen.getByRole('dialog', { name: 'Delete #renamed-ops?' }),
      ).getByRole('button', { name: 'Delete tag' }),
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toEqual({ expectedTagRevision: nextTag.revision });
  });
  it('associates tag validation and focuses the field only on submit', async () => {
    installVocabulary();
    renderTags();
    await screen.findByRole('button', { name: 'ops' });
    const field = screen.getByLabelText('New tag');
    await userEvent.type(field, 'bad.key');
    expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText(/Use up to 32 characters/);
    expect(field.getAttribute('aria-describedby')).toContain(error.id);
    await userEvent.clear(field);
    await userEvent.type(field, 'valid');
    expect(field).not.toHaveAttribute('aria-invalid', 'true');
  });
  it.each(['builder', 'viewer'] as const)(
    'does not read or show tag controls for %s',
    async (role) => {
      const read = vi.fn();
      mockServer.use(
        http.get(`${api}/workflow-tags`, () => {
          read();
          return HttpResponse.json({ items: [], nextCursor: null });
        }),
      );
      const { onClose } = renderTags(role);
      expect(screen.getByText(/Only owners and admins/)).toBeVisible();
      expect(read).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onClose).toHaveBeenCalled();
    },
  );
  it('hides tag controls after a denied write and still allows closing', async () => {
    installVocabulary();
    mockServer.use(
      http.post(`${api}/workflow-tags/${tag.id}/rename`, () =>
        problem(403, 'request.forbidden'),
      ),
    );
    const { onClose } = renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByText(/Your access changed/);
    expect(
      screen.queryByRole('button', { name: 'ops' }),
    ).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
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
    const { queryClient } = renderTags();
    await userEvent.click(await screen.findByRole('button', { name: 'ops' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
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
    renderTags();
    await userEvent.click(await screen.findByRole('button', { name: 'ops' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
    );
    await screen.findByText(/Your access changed/);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(
      screen.queryByText(workflowId, { exact: false }),
    ).not.toBeInTheDocument();
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
    renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    const confirmation = screen.getByRole('dialog', { name: 'Delete #ops?' });
    expect(
      within(confirmation).getByText(/including archived ones/),
    ).toBeInTheDocument();
    await event.click(
      within(confirmation).getByRole('button', { name: 'Delete tag' }),
    );
    await screen.findByText(/too many assignments/);
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
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
          let start = 50;
          if (after === null) start = 0;
          else if (after === cursor) start = 25;
          return HttpResponse.json({
            items: ids
              .slice(start, start + 25)
              .map((id) => ({ workflowId: id, organizationRevision: 1 })),
            nextCursor:
              new Map([
                [0, cursor],
                [25, 'opaque-page2'],
              ]).get(start) ?? null,
          });
        },
      ),
    );
    renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
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
