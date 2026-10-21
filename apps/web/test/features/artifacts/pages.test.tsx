import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { FilePages } from '@/features/artifacts/components/file-pages';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';

it('shows page metadata without loading files and authorizes a download on demand', async () => {
  const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    artifactId = '55555555-5555-4555-8555-555555555555';
  const reference = {
    kind: 'artifact',
    artifactId,
    byteLength: 65536,
    mediaType: 'application/json',
    sha256: 'a'.repeat(64),
  };
  const metadata = vi.fn(() =>
    HttpResponse.json({
      id: artifactId,
      workspaceId,
      byteLength: 65536,
      mediaType: 'application/json',
      sha256: 'a'.repeat(64),
      status: 'available',
      createdAt: '2026-10-21T10:00:00.000Z',
      expiresAt: null,
    }),
  );
  const download = vi.fn(() =>
    HttpResponse.json({
      method: 'GET',
      url: 'https://objects.example.test/page',
      expiresAt: '2026-10-21T10:10:00.000Z',
      expiresInSeconds: 600,
    }),
  );
  const base = `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts/${artifactId}`;
  mockServer.use(
    http.get(base, metadata),
    http.get(`${base}/download`, download),
  );
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <FilePages
          apiClient={createApiClient({
            fetch: testFetch,
            readCsrfToken: () => undefined,
          })}
          workspaceId={workspaceId}
          value={{
            pages: [reference],
            itemCount: 1000,
            pageCount: 1,
            fetchedPageCount: 2,
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('1,000 records · 1 page · 64 KB')).toBeVisible();
    expect(metadata).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Download data pages'));
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(
      await screen.findByRole('link', { name: 'Open download link' }),
    ).toHaveAttribute('href', 'https://objects.example.test/page');
    expect(metadata).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
  } finally {
    open.mockRestore();
  }
});
