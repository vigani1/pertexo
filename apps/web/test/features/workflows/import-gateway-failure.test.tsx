import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayFailures } from '../../support/fixtures/gateway-failures';
import { mockServer } from '../../support/mock-server';
import { mountList, prepare, retireHistories } from './import-recovery/fixture';
import { api, versionId } from './list/fixtures';

afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

describe('Workflow import after a gateway failure', () => {
  it.each(gatewayFailures)(
    'imports one workflow when the person retries after a %s',
    async (_status, gatewayFailure) => {
      // The server keeps one workflow per idempotency key, like the API does.
      const imported = new Map<string | null, unknown>();
      const attempts: (string | null)[] = [];
      mockServer.use(
        http.post(`${api}/workflows/import`, async ({ request }) => {
          const key = request.headers.get('idempotency-key');
          attempts.push(key);
          imported.set(key, await request.json());
          return attempts.length === 1
            ? gatewayFailure()
            : HttpResponse.json({ workflowId: versionId }, { status: 201 });
        }),
      );
      const { event, onCreated } = mountList();
      await prepare(event);

      await event.click(
        await screen.findByRole('button', { name: 'Retry exact import' }),
      );
      await event.click(
        await screen.findByRole('button', { name: 'Open imported workflow' }),
      );

      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBeTruthy();
      expect(imported.size).toBe(1);
      expect([...imported.values()][0]).toMatchObject({
        name: 'Frozen recovery draft',
      });
    },
  );
});
