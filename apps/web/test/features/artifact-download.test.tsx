import { HttpResponse, http } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { ArtifactDownload } from '@/features/artifacts/artifact-download';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { testFetch } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const artifactId = '55555555-5555-4555-8555-555555555555';
const secondArtifactId = '66666666-6666-4666-8666-666666666666';
const artifactUrl = `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts/${artifactId}`;

function metadata(status: 'available' | 'pending' = 'available') {
  return {
    id: artifactId,
    workspaceId,
    byteLength: 3_174,
    mediaType: 'application/json',
    sha256: 'a'.repeat(64),
    status,
    createdAt: '2026-09-14T10:00:00.000Z',
    expiresAt: null,
  };
}

function signedLink() {
  return http.get(`${artifactUrl}/download`, () =>
    HttpResponse.json({
      method: 'GET',
      url: 'https://objects.example.test/signed-artifact',
      expiresAt: '2026-09-14T10:10:00.000Z',
      expiresInSeconds: 600,
    }),
  );
}

function apiClient() {
  return createApiClient({ fetch: testFetch, readCsrfToken: () => undefined });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('artifact download', () => {
  it('checks the file is ready, then opens the signed link in one click', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mockServer.use(
      http.get(artifactUrl, () => HttpResponse.json(metadata())),
      signedLink(),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={apiClient()}
          workspaceId={workspaceId}
          artifactId={artifactId}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole('link', { name: 'Open download link' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(
      await screen.findByRole('link', { name: 'Open download link' }),
    ).toHaveAttribute('href', 'https://objects.example.test/signed-artifact');
    expect(open).toHaveBeenCalledWith(
      'https://objects.example.test/signed-artifact',
      '_blank',
    );
  });

  it('shows the file type and size up front and refuses a file still being written', async () => {
    let downloads = 0;
    mockServer.use(
      http.get(artifactUrl, () => HttpResponse.json(metadata('pending'))),
      http.get(`${artifactUrl}/download`, () => {
        downloads += 1;
        return HttpResponse.json({});
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={apiClient()}
          userId={userId}
          workspaceId={workspaceId}
          artifactId={artifactId}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('JSON file')).toBeVisible();
    expect(screen.getByText('application/json · 3.1 KB')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file is still being written.',
    );
    expect(downloads).toBe(0);
  });

  it('drops a prepared link and ignores a late response when the file changes', async () => {
    let releaseMetadata: (() => void) | undefined;
    const metadataBlocked = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    mockServer.use(
      http.get(artifactUrl, async () => {
        await metadataBlocked;
        return HttpResponse.json(metadata());
      }),
    );
    const client = apiClient();
    const rendered = render(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={client}
          workspaceId={workspaceId}
          artifactId={artifactId}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    rendered.rerender(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={client}
          workspaceId={workspaceId}
          artifactId={secondArtifactId}
        />
      </QueryClientProvider>,
    );
    releaseMetadata?.();
    expect(await screen.findByText('6666…6666')).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Open download link' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });
});
