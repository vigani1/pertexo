import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { formConfigSchema } from '@pertexo/workflow-model';
import { FormPage } from '@/features/forms/pages/form';
import { formQueryOptions } from '@/features/forms/data/forms.queries';
import type { FormScope } from '@/features/forms/data/forms.api';
import { createApiClient } from '@/lib/api/client';
import { createQueryClient } from '@/app/query-client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
const publicId = '11111111-1111-4111-8111-111111111111',
  versionId = '22222222-2222-4222-8222-222222222222';
const path = `http://pertexo.test/v1/forms/${publicId}`;
const form = formConfigSchema.parse({});
function mount() {
  const scope: FormScope = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    }),
    target: {
      kind: 'public',
      publicId,
      capability: 'a'.repeat(43),
      authority: 'b'.repeat(64),
    },
  };
  const cache = createQueryClient();
  render(
    <QueryClientProvider client={cache}>
      <FormPage scope={scope} />
    </QueryClientProvider>,
  );
  return { cache, key: formQueryOptions(scope).queryKey };
}
it('keeps the accepted plain receipt after schema changes and a later read failure', async () => {
  let unavailable = false;
  mockServer.use(
    http.get(path, () =>
      unavailable
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({ versionId, form }),
    ),
    http.post(`${path}/submit`, () =>
      HttpResponse.json({
        accepted: true,
        replayed: false,
        thankYouMessage: '<b>Received</b>',
      }),
    ),
  );
  const { cache, key } = mount(),
    user = userEvent.setup();
  await user.type(
    await screen.findByLabelText('Message', { exact: true }),
    'Original',
  );
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await screen.findByRole('heading', { name: 'Response sent' });
  expect(screen.getByText('<b>Received</b>', { exact: true })).toBeVisible();
  expect(document.querySelector('b')).toBeNull();
  act(() => {
    cache.setQueryData(key, {
      versionId: publicId,
      form: { ...form, title: 'New publication' },
    });
  });
  unavailable = true;
  await act(async () => {
    await cache.refetchQueries({ queryKey: key });
  });
  expect(screen.getByRole('heading', { name: 'Response sent' })).toBeVisible();
  expect(screen.getByText('<b>Received</b>', { exact: true })).toBeVisible();
  expect(
    screen.queryByText('The form could not be loaded.', { exact: false }),
  ).toBeNull();
});
it('retains an uncertain original command across a schema refresh', async () => {
  const writes: { key: string | null; body: unknown }[] = [];
  mockServer.use(
    http.get(path, () => HttpResponse.json({ versionId, form })),
    http.post(`${path}/submit`, async ({ request }) => {
      writes.push({
        key: request.headers.get('Idempotency-Key'),
        body: await request.json(),
      });
      return writes.length === 1
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({
            accepted: true,
            replayed: true,
            thankYouMessage: 'Original accepted message.',
          });
    }),
  );
  const { cache, key } = mount(),
    user = userEvent.setup();
  await user.type(
    await screen.findByLabelText('Message', { exact: true }),
    'Original',
  );
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await screen.findByRole('button', { name: 'Retry same response' });
  act(() => {
    cache.setQueryData(key, {
      versionId: publicId,
      form: { ...form, title: 'New publication' },
    });
  });
  await screen.findByRole('heading', { name: 'New publication' });
  await user.click(screen.getByRole('button', { name: 'Retry same response' }));
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  await screen.findByRole('heading', { name: 'Response sent' });
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]?.body).toEqual({
    versionId,
    values: { message: 'Original' },
  });
  expect(
    screen.getByText('Original accepted message.', { exact: true }),
  ).toBeVisible();
});

it('keeps entered values after a definite busy response and uses a new key for a fresh attempt', async () => {
  const keys: (string | null)[] = [];
  mockServer.use(
    http.get(path, () => HttpResponse.json({ versionId, form })),
    http.post(`${path}/submit`, ({ request }) => {
      keys.push(request.headers.get('Idempotency-Key'));
      return HttpResponse.json(
        keys.length === 1
          ? {
              accepted: false,
              skipped: true,
              reason: 'concurrency_limit',
              replayed: false,
            }
          : { accepted: true, replayed: false, thankYouMessage: 'Received.' },
      );
    }),
  );
  mount();
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText('Message', { exact: true }),
    'Keep this response',
  );
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(
    await screen.findByText('This workflow is busy.', { exact: false }),
  ).toBeVisible();
  expect(screen.getByLabelText('Message', { exact: true })).toHaveValue(
    'Keep this response',
  );
  expect(screen.queryByRole('heading', { name: 'Response sent' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await screen.findByRole('heading', { name: 'Response sent' });
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
});
