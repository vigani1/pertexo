import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { gatewayFailures } from '../../support/fixtures/gateway-failures';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  problem,
  renameResponse,
  user,
  workspace,
  workspaceId,
} from './general/fixture';

describe('workspace rename after a gateway failure', () => {
  it.each(gatewayFailures)(
    'lands once when the person saves again after a %s',
    async (_status, gatewayFailure) => {
      // Like the API: a key replays its receipt, and a new rename applies
      // only against the revision it read.
      let current = workspace;
      const applied: string[] = [];
      const receipts = new Map<string | null, typeof workspace>();
      let requests = 0;
      mockServer.use(
        http.get('http://pertexo.test/v1/users/me', () =>
          HttpResponse.json(user),
        ),
        http.get('http://pertexo.test/v1/workspaces', () =>
          HttpResponse.json({ items: [current], nextCursor: null }),
        ),
        http.patch(
          `http://pertexo.test/v1/workspaces/${workspaceId}`,
          async ({ request }) => {
            requests += 1;
            const key = request.headers.get('idempotency-key');
            const receipt = receipts.get(key);
            if (receipt !== undefined)
              return HttpResponse.json(renameResponse(receipt, true));
            const body = (await request.json()) as {
              name: string;
              expectedRevision: number;
            };
            if (body.expectedRevision !== current.revision)
              return problem(
                409,
                'workspace.revision_conflict',
                'Workspace changed',
              );
            current = {
              ...current,
              name: body.name,
              revision: current.revision + 1,
            };
            applied.push(body.name);
            receipts.set(key, current);
            return requests === 1
              ? gatewayFailure()
              : HttpResponse.json(renameResponse(current, false));
          },
        ),
      );
      await renderLoadedApp(`/w/${workspaceId}/settings`);
      const event = userEvent.setup();
      await event.click(
        await screen.findByRole('button', { name: 'Rename workspace' }),
      );
      const input = screen.getByLabelText('Workspace name');
      await event.clear(input);
      await event.type(input, 'Incident Operations');
      await event.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(/couldn’t confirm/u)).toBeVisible();

      await event.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(requests).toBe(2);
      });
      // The resend replays the person's own rename instead of reporting it
      // as someone else's change.
      expect(
        await screen.findByText('Renamed to Incident Operations'),
      ).toBeVisible();
      expect(
        screen.queryByText(/changed while you were editing|meanwhile/u),
      ).not.toBeInTheDocument();
      expect(applied).toEqual(['Incident Operations']);
    },
  );
});
