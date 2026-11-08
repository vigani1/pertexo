import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { formFieldsSchema } from '@pertexo/workflow-model';
import { FormResponse } from '@/features/forms/components/response';
import { uploadTarget } from '@/features/forms/data/uploads.api';
import { createApiClient } from '@/lib/api/client';
import { testFetch } from '../../../support/render-app';
import { mockServer } from '../../../support/mock-server';
import { file, store, storeAccepts, stubWebCrypto } from './fixture';

stubWebCrypto();
it('offers retry only when the failed file has room beside its replacement', async () => {
  let starts = 0;
  const uploadId = '00000000-0000-4000-8000-000000000001';
  const metadata = {
    id: uploadId,
    filename: 'b.pdf',
    byteLength: 9,
    mediaType: 'application/pdf',
    status: 'available',
    expiresAt: '2027-01-01T00:00:00.000Z',
  };
  mockServer.use(
    http.post('http://pertexo.test/v1/forms/test/uploads', () => {
      starts++;
      return starts === 1
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({
            upload: { ...metadata, status: 'pending' },
            transfer: {
              method: 'PUT',
              url: store,
              headers: {},
              expiresAt: metadata.expiresAt,
              expiresInSeconds: 900,
            },
            replayed: false,
          });
    }),
    http.post(
      `http://pertexo.test/v1/forms/test/uploads/${uploadId}/finalize`,
      () => HttpResponse.json(metadata),
    ),
  );
  storeAccepts();
  render(
    <FormResponse
      fields={formFieldsSchema.parse([
        {
          id: 'invoice',
          name: 'invoice',
          label: 'Invoice',
          type: 'file',
          maxFiles: 1,
          accept: ['documents'],
        },
      ])}
      uploads={uploadTarget({
        apiClient: createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        }),
        path: '/v1/forms/test',
        session: 'S'.repeat(43),
        external: true,
      })}
      onSubmit={() => Promise.resolve()}
    />,
  );
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), file('a.pdf'));
  await screen.findByRole('button', { name: 'Retry a.pdf' });
  await user.upload(screen.getByLabelText('Invoice'), file('b.pdf'));
  await screen.findByText(/· Attached$/u);
  expect(screen.getByRole('button', { name: 'Retry a.pdf' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry a.pdf' }));
  expect(starts).toBe(2);
  await user.click(screen.getByRole('button', { name: 'Remove b.pdf' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry a.pdf' })).toBeEnabled(),
  );
});

it('keeps an attached file visible after a safe server refusal and focuses Remove so it can be replaced', async () => {
  const { FormPage } = await import('@/features/forms/pages/form');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  const { createQueryClient } = await import('@/app/query-client');
  const publicId = '11111111-1111-4111-8111-111111111111';
  const versionId = '22222222-2222-4222-8222-222222222222';
  const uploadId = '33333333-3333-4333-8333-333333333333';
  const path = `http://pertexo.test/v1/forms/${publicId}`;
  const instruction =
    'A file is no longer available. Remove it and upload it again.';
  const metadata = {
    id: uploadId,
    filename: 'invoice.pdf',
    byteLength: 9,
    mediaType: 'application/pdf',
    status: 'available',
    expiresAt: '2027-01-01T00:00:00.000Z',
  };
  mockServer.use(
    http.get(path, () =>
      HttpResponse.json({
        versionId,
        form: {
          title: 'Invoice',
          instructions: '',
          fields: [
            {
              id: 'invoice',
              name: 'invoice',
              label: 'Invoice',
              type: 'file',
              accept: ['documents'],
              maxFiles: 1,
            },
          ],
        },
      }),
    ),
    http.post(`${path}/uploads`, () =>
      HttpResponse.json({
        upload: { ...metadata, status: 'pending' },
        transfer: {
          method: 'PUT',
          url: store,
          headers: {},
          expiresAt: metadata.expiresAt,
          expiresInSeconds: 900,
        },
        replayed: false,
      }),
    ),
    http.post(`${path}/uploads/${uploadId}/finalize`, () =>
      HttpResponse.json(metadata),
    ),
    http.post(`${path}/submit`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:form.invalid',
          title: 'Check the form fields',
          status: 400,
          code: 'form.invalid',
          requestId: 'file-refusal',
          errors: [
            { path: 'invoice', code: 'invalid_value', message: instruction },
          ],
        },
        {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  );
  storeAccepts();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FormPage
        scope={{
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
        }}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.upload(
    await screen.findByLabelText('Invoice'),
    file('invoice.pdf'),
  );
  await screen.findByText(/· Attached$/u);
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(await screen.findByText(instruction)).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Remove invoice.pdf' }),
  ).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Remove invoice.pdf' }));
  expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Invoice')).toBeEnabled();
});
