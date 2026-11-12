import { coldStart } from '../../../support/fixtures/run';
import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import { gatewayFailures } from '../../../support/fixtures/gateway-failures';
import {
  api,
  createdResponse,
  discoveryHandlers,
  draftHandler,
  organizedPage,
  summary,
  workflowId,
  workspaceId,
} from './fixtures';

describe('new workflow after a gateway failure', () => {
  it.each(gatewayFailures)(
    'creates one workflow when the person submits again after a %s',
    async (_status, gatewayFailure) => {
      // The server keeps one workflow per idempotency key, like the API does.
      const created = new Map<string, unknown>();
      const keys: (string | null)[] = [];
      mockServer.use(
        ...discoveryHandlers(),
        http.get(`${api}/workflows`, () =>
          HttpResponse.json(organizedPage({ items: [], nextCursor: null })),
        ),
        http.get(`${api}/workflows/${workflowId}`, () =>
          HttpResponse.json({ workflow: summary(workflowId, 'Nightly sync') }),
        ),
        draftHandler(),
        http.post(`${api}/workflows`, async ({ request }) => {
          const key = request.headers.get('idempotency-key');
          keys.push(key);
          created.set(key ?? crypto.randomUUID(), await request.json());
          return keys.length === 1
            ? gatewayFailure()
            : createdResponse(workflowId, 'Nightly sync');
        }),
      );
      const { router } = await renderLoadedApp(`/w/${workspaceId}/workflows`);
      const event = userEvent.setup();
      await screen.findByRole(
        'heading',
        { name: 'Weave your first workflow' },
        coldStart,
      );
      await event.click(screen.getByRole('button', { name: 'New workflow' }));
      const dialog = await screen.findByRole(
        'dialog',
        { name: 'New workflow' },
        coldStart,
      );
      await event.type(
        within(dialog).getByLabelText('Workflow name'),
        'Nightly sync',
      );
      await event.click(
        within(dialog).getByRole('button', { name: 'Create workflow' }),
      );
      expect(
        await screen.findByText(
          /couldn’t confirm whether the workflow was created/u,
        ),
      ).toBeVisible();

      // The same submit button, now named for what it does.
      await event.click(
        within(dialog).getByRole('button', { name: 'Retry safely' }),
      );

      await waitFor(() => {
        expect(router.state.location.pathname).toBe(
          `/w/${workspaceId}/workflows/${workflowId}`,
        );
      });
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect([...created.values()]).toEqual([{ name: 'Nightly sync' }]);
    },
  );
});
