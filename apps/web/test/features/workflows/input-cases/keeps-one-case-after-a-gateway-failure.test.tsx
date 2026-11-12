import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { gatewayFailures } from '../../../support/fixtures/gateway-failures';
import { mockServer } from '../../../support/mock-server';
import { caseId, open, path } from './fixture';

describe('shared workflow input cases after a gateway failure', () => {
  it.each(gatewayFailures)(
    'saves one case when the person clicks Save again after a %s',
    async (_status, gatewayFailure) => {
      // The server keeps one case per idempotency key, like the API does.
      const saved = new Map<string | null, unknown>();
      let posts = 0;
      mockServer.use(
        http.post(path, async ({ request }) => {
          posts += 1;
          const replayed = saved.has(request.headers.get('idempotency-key'));
          saved.set(
            request.headers.get('idempotency-key'),
            await request.json(),
          );
          return posts === 1
            ? gatewayFailure()
            : HttpResponse.json(
                { caseId, revision: 1, replayed },
                { status: 201 },
              );
        }),
      );
      const { event } = open();
      await event.click(
        await screen.findByRole('button', { name: 'New input case' }),
      );
      await event.type(await screen.findByLabelText('Case name'), 'Lost case');
      await event.click(
        screen.getByRole('button', { name: 'Save input case' }),
      );
      await screen.findByText(/couldn’t confirm whether the case was saved/u);

      await event.click(
        screen.getByRole('button', { name: 'Save input case' }),
      );

      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: 'Save input case' }),
        ).not.toBeInTheDocument();
      });
      expect(posts).toBe(2);
      expect(saved.size).toBe(1);
      expect([...saved.keys()][0]).toBeTruthy();
      expect([...saved.values()][0]).toMatchObject({ name: 'Lost case' });
    },
  );
});
