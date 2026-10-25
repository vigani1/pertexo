import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { SharingPrincipalPicker } from '@/components/patterns/sharing/principal-picker';
import { ROLE_NAMES } from '@/features/workspaces/roles.public';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { renderInRouter } from '../support/render-in-router';
import { testFetch } from '../support/render-app';
import { CaseBrowser } from '../features/workflows/input-cases/browsers';
import { metadata, path } from '../features/workflows/input-cases/fixture';
import {
  api,
  discoveryHandlers,
  summary,
  userId,
  versionId,
  workflowId,
  workspaceId,
  workspaceWith,
} from '../features/workflows/list/fixtures';

it.each(['people', 'input cases'] as const)(
  'keeps %s pagination disabled while the editor is locked',
  async (kind) => {
    const requests = vi.fn();
    mockServer.use(
      ...discoveryHandlers(['workflow:update']),
      http.get(`${api}/resource-sharing-principals`, ({ request }) => {
        requests(new URL(request.url).searchParams.get('after'));
        return HttpResponse.json({ items: [], next: metadata.id });
      }),
      http.get(path, ({ request }) => {
        requests(new URL(request.url).searchParams.get('after'));
        return HttpResponse.json({
          items: [metadata],
          nextCursor: metadata.id,
        });
      }),
    );
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => 'csrf-token-1234567890',
    });
    function LockedPicker() {
      const [locked, setLocked] = useState(true);
      return (
        <>
          <button
            onClick={() => {
              setLocked(false);
            }}
          >
            Unlock
          </button>
          {kind === 'people' ? (
            <SharingPrincipalPicker
              scope={{ apiClient, userId, workspaceId }}
              kinds={['member']}
              roleNames={ROLE_NAMES}
              selected={[]}
              full={false}
              disabled={locked}
              onAdd={() => undefined}
            />
          ) : (
            <CaseBrowser
              apiClient={apiClient}
              userId={userId}
              scope={{
                workspace: accessibleWorkspaceSchema.parse(
                  workspaceWith(['workflow:update']),
                ),
                workflow: workflowSummarySchema.parse(
                  summary(workflowId, 'Case workflow', {
                    publishedVersionId: versionId,
                  }),
                ),
              }}
              disabled={locked}
              onLoad={() => undefined}
            />
          )}
        </>
      );
    }
    renderInRouter(<LockedPicker />);
    const label =
      kind === 'people' ? 'Show more people' : 'Load more input cases';
    const more = await screen.findByRole('button', { name: label });
    expect(more).toBeDisabled();
    const event = userEvent.setup();
    await event.click(more);
    expect(requests.mock.calls).toEqual([[null]]);
    await event.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(more).toBeEnabled();
    await event.click(more);
    expect(requests.mock.calls).toEqual([[null], [metadata.id]]);
  },
);
