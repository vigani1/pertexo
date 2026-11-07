import { useState } from 'react';
import type { FolderAction } from '@/features/workflows/components/organization/folders/shelf';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import {
  accessibleWorkspaceSchema,
  type WorkflowFolder,
} from '@pertexo/contracts';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';
import { FolderActionDialog } from '@/features/workflows/components/organization/folders/actions';
import { workflowFoldersQueryOptions } from '@/features/workflows/data/organization/workflow-organization.queries';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  api,
  userId,
  workflowId,
  secondWorkflowId,
  workspaceWith,
  discoveryHandlers,
  problem,
} from '../list/fixtures';
const operations: WorkflowFolder = {
  id: workflowId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
  accessMode: 'workspace',
};
const finance: WorkflowFolder = {
  ...operations,
  id: secondWorkflowId,
  name: 'Finance',
  revision: 4,
};
it.each(
  ['rename', 'move', 'delete'].flatMap((kind) =>
    [false, true].map((failRead) => ({
      kind: kind as 'rename' | 'move' | 'delete',
      failRead,
    })),
  ),
)(
  'reviews the current folder before retrying a refused $kind (read fails: $failRead)',
  async ({ kind, failRead }) => {
    mockServer.use(...discoveryHandlers());
    const workspace = accessibleWorkspaceSchema.parse({
      ...workspaceWith(['workflow:read', 'workflow:update']),
      role: 'owner',
    });
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => 'csrf-token-1234567890',
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let current = operations;
    const bodies: unknown[] = [];
    let readFailed = false;
    mockServer.use(
      http.get(`${api}/workflow-folders`, () => {
        if (failRead && bodies.length === 1 && !readFailed) {
          readFailed = true;
          return problem(503, 'internal.unexpected');
        }
        return HttpResponse.json({ items: [current, finance] });
      }),
      http.post(`${api}/workflow-folders/review-move`, () =>
        HttpResponse.json({
          items: [
            {
              id: operations.id,
              requiresReview: false,
              token: 'b'.repeat(64),
              removedRestrictions: [],
            },
          ],
        }),
      ),
      http.post(
        `${api}/workflow-folders/${operations.id}/${kind}`,
        async ({ request }) => {
          bodies.push(await request.json());
          if (bodies.length === 1) {
            current = {
              ...operations,
              revision: 3,
              name: 'Current Operations',
              parentId: kind === 'delete' ? finance.id : operations.parentId,
              depth: kind === 'delete' ? 2 : operations.depth,
            };
            return problem(409, 'workflow.folder_revision_conflict');
          }
          return HttpResponse.json(
            kind === 'delete'
              ? { folderId: operations.id, deleted: true, replayed: false }
              : { folder: { ...current, revision: 4 }, replayed: false },
          );
        },
      ),
    );
    function Editor() {
      const [finished, setFinished] = useState<FolderAction>();
      const reader = useQuery(
        workflowFoldersQueryOptions(apiClient, userId, workspace.id),
      );
      return reader.data ? (
        <>
          <FolderActionDialog
            apiClient={apiClient}
            userId={userId}
            workspace={workspace}
            folders={reader.data.items}
            action={{ kind, folder: operations }}
            onClose={() => undefined}
            onDone={setFinished}
          />
          {finished === undefined ? null : (
            <output aria-label="Completed folder action">
              {JSON.stringify(finished)}
            </output>
          )}
        </>
      ) : null;
    }
    render(
      <QueryClientProvider client={cache}>
        <NotificationsProvider>
          <Editor />
        </NotificationsProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const submit = {
      rename: 'Save name',
      move: 'Move folder',
      delete: 'Delete folder',
    }[kind];
    if (kind === 'rename') {
      const field = await screen.findByLabelText('Name');
      await user.clear(field);
      await user.type(field, 'My retained name');
    } else if (kind === 'move') {
      await user.click(
        await screen.findByRole('combobox', { name: 'Move to' }),
      );
      await user.click(await screen.findByRole('option', { name: 'Finance' }));
    }
    await user.click(await screen.findByRole('button', { name: submit }));
    const review = await screen.findByRole('button', {
      name: 'Keep edits and use latest revision',
    });
    if (failRead) {
      expect(review).toBeDisabled();
      expect(
        await screen.findByRole('button', { name: /^Copy error ID/u }),
      ).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
    }
    await waitFor(() => {
      expect(review).toBeEnabled();
    });
    await user.click(review);
    if (kind === 'rename')
      expect(screen.getByLabelText('Name')).toHaveValue('My retained name');
    await user.click(screen.getByRole('button', { name: submit }));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toMatchObject({ expectedFolderRevision: 3 });
    if (kind === 'delete') {
      const completed = await screen.findByLabelText('Completed folder action');
      expect(JSON.parse(completed.textContent) as unknown).toMatchObject({
        kind: 'delete',
        folder: { id: operations.id, parentId: finance.id, revision: 3 },
      });
    }
    if (kind === 'rename')
      expect(bodies[1]).toMatchObject({ name: 'My retained name' });
    if (kind === 'move')
      expect(bodies[1]).toMatchObject({ parentId: finance.id });
  },
);
