import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { mountList, prepare } from './import-recovery/fixture';
import { api, curatedCatalog } from './list/fixtures';

it('lets an explicit example replace an unconfirmed file import without sending automatically', async () => {
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
  mockServer.use(
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json(curatedCatalog()),
    ),
  );
  await prepare(event);
  await screen.findByText(/couldn’t confirm/u);
  await event.click(screen.getByRole('button', { name: 'Cancel' }));
  const example = CURATED_WORKFLOW_TEMPLATES[0];
  if (example === undefined) throw new Error('Expected a curated example');
  await event.click(
    screen.getByRole('button', { name: new RegExp(example.title, 'u') }),
  );
  const choose = await screen.findByRole('button', {
    name: `Set up ${example.title}`,
  });
  await waitFor(() => expect(choose).toBeEnabled());
  await event.click(choose);
  expect(attempts).toHaveLength(1);
  const previewButton = screen.getByRole('button', { name: 'Preview import' });
  await waitFor(() => expect(previewButton).toBeEnabled());
  await event.click(previewButton);
  await screen.findByText(/Compatible with this workspace/u);
  await event.click(
    screen.getByRole('button', { name: 'Import unpublished draft' }),
  );
  await screen.findByText(/couldn’t confirm/u);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.key).not.toEqual(attempts[0]?.key);
  expect(attempts[1]?.body).not.toEqual(attempts[0]?.body);
  expect(screen.getByLabelText('New workflow name')).toHaveValue(example.title);
});
