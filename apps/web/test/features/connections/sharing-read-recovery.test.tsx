import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import type { ConnectionSharing, FolderSharing } from '@pertexo/contracts';
import { NotificationsProvider } from '@/components/ui/toast';
import { ConnectionSharingPanel } from '@/features/connections/components/sharing/panel';
import { FolderShareDialog } from '@/features/workflows/components/organization/folders/share-dialog';
import { useConnectionSharingEditor } from '@/features/connections/hooks/use-sharing-editor';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  discoveryHandlers,
  userId,
  workspaceId,
  workflowId,
} from '../workflows/list/fixtures';

it.each(['connection', 'folder'] as const)(
  'retries a failed %s conflict read without discarding the selected people',
  async (kind) => {
    const resourceId = workflowId;
    const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
    const url = `${api}/${kind === 'connection' ? 'connections' : 'workflow-folders'}/${resourceId}/sharing`;
    const scope = {
      userId,
      workspaceId,
      apiClient: createApiClient({
        fetch: testFetch,
        readCsrfToken: () => 'csrf-token-1234567890',
      }),
    };
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let current: ConnectionSharing | FolderSharing =
      kind === 'connection'
        ? {
            connectionId: resourceId,
            revision: 1,
            mode: 'workspace',
            members: [],
          }
        : {
            folderId: resourceId,
            revision: 1,
            mode: 'workspace',
            grants: [],
            labels: {},
          };
    const bodies: unknown[] = [];
    let failedRead = false;
    let finishRetry: (() => void) | undefined;
    mockServer.use(
      ...discoveryHandlers(),
      http.get(`${api}/resource-sharing-principals`, () =>
        HttpResponse.json({
          items: [
            {
              kind: 'member',
              userId,
              label: 'Jane',
              email: 'jane@example.test',
              role: 'builder',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get(url, async () => {
        if (bodies.length === 1) {
          if (!failedRead) {
            failedRead = true;
            return HttpResponse.json(
              {
                type: 'about:blank',
                title: 'Unavailable',
                status: 503,
                code: 'internal.unexpected',
                requestId: 'current-sharing-unavailable',
              },
              {
                status: 503,
                headers: { 'content-type': 'application/problem+json' },
              },
            );
          }
          await new Promise<void>((resolve) => {
            finishRetry = resolve;
          });
        }
        return HttpResponse.json(current);
      }),
      http.post(url, async ({ request }) => {
        bodies.push(await request.json());
        if (bodies.length === 1) {
          current = { ...current, revision: 2 };
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Changed',
              status: 409,
              code:
                kind === 'connection'
                  ? 'connection.conflict'
                  : 'workflow.folder_revision_conflict',
              requestId: 'sharing-refused',
            },
            {
              status: 409,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
        current =
          kind === 'connection'
            ? {
                connectionId: resourceId,
                revision: 3,
                mode: 'restricted',
                members: [{ userId, label: 'Jane', active: true }],
              }
            : {
                folderId: resourceId,
                revision: 3,
                mode: 'restricted',
                grants: [{ kind: 'member', userId, access: 'viewer' }],
                labels: { [userId]: 'Jane' },
              };
        return HttpResponse.json({ ...current, replayed: false });
      }),
    );
    function ConnectionPanel() {
      const editor = useConnectionSharingEditor(scope, resourceId);
      return (
        <ConnectionSharingPanel
          scope={scope}
          editor={editor}
          onDone={() => undefined}
        />
      );
    }
    render(
      <QueryClientProvider client={cache}>
        <NotificationsProvider>
          {kind === 'connection' ? (
            <ConnectionPanel />
          ) : (
            <FolderShareDialog
              scope={scope}
              folder={{
                id: resourceId,
                name: 'Operations',
                parentId: null,
                revision: 1,
                depth: 1,
              }}
              folders={[]}
              onClose={() => undefined}
            />
          )}
        </NotificationsProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('radio', { name: /Only people you choose/ }),
    );
    await user.click(await screen.findByRole('button', { name: 'Add Jane' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('current-sharing-unavailable'),
    ).toBeVisible();
    const review = screen.getByRole('button', {
      name: 'Keep edits and use latest revision',
    });
    expect(review).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Jane' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(finishRetry).toBeDefined();
    });
    expect(review).toBeDisabled();
    expect(bodies).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove Jane' })).toBeVisible();
    finishRetry?.();
    await waitFor(() => {
      expect(review).toBeEnabled();
    });
    expect(
      screen.queryByText('current-sharing-unavailable'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Jane' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(review);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toEqual(
      kind === 'connection'
        ? { mode: 'restricted', expectedSharingRevision: 2, userIds: [userId] }
        : {
            mode: 'restricted',
            expectedFolderRevision: 2,
            grants: [{ kind: 'member', userId, access: 'viewer' }],
          },
    );
    cache.clear();
  },
);
