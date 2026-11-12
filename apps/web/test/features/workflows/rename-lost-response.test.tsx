import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { gatewayFailures } from '../../support/fixtures/gateway-failures';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  installQueries,
  summary,
  workflowApi,
  workflowId,
  workspaceId,
} from '../workflow-settings/fixtures';

const versionsPath = `/w/${workspaceId}/workflows/${workflowId}/versions`;

describe('workflow rename after a gateway failure', () => {
  it.each(gatewayFailures)(
    'lands once when the person saves again after a %s',
    async (_status, gatewayFailure) => {
      // Like the API: a key replays its receipt, and a new rename applies
      // only against the revision it read.
      let current = summary;
      const applied: string[] = [];
      const receipts = new Map<string | null, typeof summary>();
      let requests = 0;
      installQueries();
      mockServer.use(
        http.get(workflowApi, () => HttpResponse.json({ workflow: current })),
        http.post(`${workflowApi}/rename`, async ({ request }) => {
          requests += 1;
          const key = request.headers.get('idempotency-key');
          const receipt = receipts.get(key);
          if (receipt !== undefined)
            return HttpResponse.json({ workflow: receipt, replayed: true });
          const body = (await request.json()) as {
            name: string;
            expectedNameRevision: number;
          };
          if (body.expectedNameRevision !== current.nameRevision)
            return HttpResponse.json(
              {
                type: 'urn:pertexo:problem:workflow.name_conflict',
                title: 'Workflow name conflict',
                status: 409,
                code: 'workflow.name_conflict',
                requestId: 'request-name-conflict',
                currentNameRevision: current.nameRevision,
              },
              {
                status: 409,
                headers: { 'content-type': 'application/problem+json' },
              },
            );
          current = {
            ...current,
            name: body.name,
            nameRevision: current.nameRevision + 1,
          };
          applied.push(body.name);
          receipts.set(key, current);
          return requests === 1
            ? gatewayFailure()
            : HttpResponse.json({ workflow: current, replayed: false });
        }),
      );
      await renderLoadedApp(versionsPath);
      const event = userEvent.setup();
      await event.click(
        await screen.findByRole('button', { name: 'Rename workflow' }),
      );
      const input = screen.getByLabelText('Workflow name');
      await event.clear(input);
      await event.type(input, 'Morning control');
      await event.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(/couldn’t confirm/u)).toBeVisible();

      await event.click(screen.getByRole('button', { name: 'Save' }));

      // The first send landed; the person's own name is now current.
      await waitFor(() => {
        expect(requests).toBe(2);
      });
      // Settled: the editor closed, or the page answered the second Save.
      await waitFor(() => {
        expect(
          screen.queryByLabelText('Workflow name') === null ||
            screen.queryByRole('button', { name: 'Keep mine' }) !== null,
        ).toBe(true);
      });
      // Their own change is not someone else's, and nothing offers to apply
      // it a second time.
      expect(screen.queryByText(/meanwhile/u)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Keep mine' }),
      ).not.toBeInTheDocument();
      expect(applied).toEqual(['Morning control']);
    },
  );
});
