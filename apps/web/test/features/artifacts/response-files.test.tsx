import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { ResponseFiles } from '@/features/artifacts/components/response-files';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';

it('names each uploaded file in a response and downloads it on demand', async () => {
  const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    artifactId = '66666666-6666-4666-8666-666666666666';
  const base = `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts/${artifactId}`;
  const download = vi.fn(() =>
    HttpResponse.json({
      method: 'GET',
      url: 'https://objects.example.test/invoice',
      expiresAt: '2026-10-26T10:10:00.000Z',
      expiresInSeconds: 60,
    }),
  );
  mockServer.use(
    http.get(base, () =>
      HttpResponse.json({
        id: artifactId,
        workspaceId,
        byteLength: 2_048,
        mediaType: 'application/pdf',
        sha256: 'a'.repeat(64),
        status: 'available',
        createdAt: '2026-10-26T10:00:00.000Z',
        expiresAt: null,
      }),
    ),
    http.get(`${base}/download`, download),
  );
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ResponseFiles
          apiClient={createApiClient({
            fetch: testFetch,
            readCsrfToken: () => undefined,
          })}
          userId="member"
          workspaceId={workspaceId}
          value={{
            values: {
              note: 'Paid',
              invoice: [
                {
                  file: {
                    kind: 'artifact',
                    artifactId,
                    byteLength: 2_048,
                    mediaType: 'application/pdf',
                    sha256: 'a'.repeat(64),
                  },
                  filename: 'March invoice.pdf',
                },
              ],
            },
          }}
        />
      </QueryClientProvider>,
    );
    const files = screen.getByRole('region', { name: 'Uploaded files' });
    expect(within(files).getByText('March invoice.pdf')).toBeVisible();
    expect(await within(files).findByText('PDF document · 2 KB')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Download March invoice.pdf' }),
    );
    expect(download).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      'https://objects.example.test/invoice',
      '_blank',
    );
  } finally {
    open.mockRestore();
  }
});

it('shows nothing for a value without uploaded files', () => {
  const { container } = render(
    <ResponseFiles
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () => undefined,
      })}
      userId="member"
      workspaceId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      value={{ values: { note: 'Paid', tags: ['a', 'b'] } }}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});
