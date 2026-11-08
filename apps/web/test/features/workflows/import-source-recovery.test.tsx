import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { mountList, prepare } from './import-recovery/fixture';
import { api } from './list/fixtures';

it('reopens the unresolved file import when an example is chosen and retries its exact command', async () => {
  const attempts: { body: unknown; key: string | null }[] = [];
  mockServer.use(
    http.post(`${api}/workflows/import`, async ({ request }) => {
      attempts.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      return HttpResponse.error();
    }),
  );
  const { event } = mountList();
  await prepare(event);
  await screen.findByRole('button', { name: 'Retry exact import' });
  await event.click(screen.getByRole('button', { name: 'Close' }));
  const example = CURATED_WORKFLOW_TEMPLATES[0];
  if (example === undefined) throw new Error('Expected a curated example');
  await event.click(
    screen.getByRole('button', { name: new RegExp(example.title, 'u') }),
  );
  await event.click(
    await screen.findByRole('button', { name: 'Retry exact import' }),
  );
  await screen.findByRole('button', { name: 'Retry exact import' });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(screen.getByLabelText('New workflow name')).toHaveValue(
    'Frozen recovery draft',
  );
});
