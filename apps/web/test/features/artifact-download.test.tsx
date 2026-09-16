import { HttpResponse, http } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { ArtifactDownload } from '@/features/artifacts/artifact-download';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { testFetch } from '../support/render-app';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const artifactId = '55555555-5555-4555-8555-555555555555';
const secondArtifactId = '66666666-6666-4666-8666-666666666666';

describe('artifact download', () => {
  it('requires an available metadata read before exposing the signed link', async () => {
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts/${artifactId}`,
        () =>
          HttpResponse.json({
            id: artifactId,
            workspaceId,
            byteLength: 12,
            mediaType: 'application/json',
            sha256: 'a'.repeat(64),
            status: 'available',
            createdAt: '2026-09-14T10:00:00.000Z',
            expiresAt: null,
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts/${artifactId}/download`,
        () =>
          HttpResponse.json({
            method: 'GET',
            url: 'https://objects.example.test/signed-artifact',
            expiresAt: '2026-09-14T10:10:00.000Z',
            expiresInSeconds: 600,
          }),
      ),
    );
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={apiClient}
          workspaceId={workspaceId}
          artifactId={artifactId}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole('link', { name: 'Download artifact' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Prepare download' }),
    );
    expect(
      await screen.findByRole('link', { name: 'Download artifact' }),
    ).toHaveAttribute('href', 'https://objects.example.test/signed-artifact');
  });

  it('drops a prepared link and ignores a late response when artifact identity changes', async () => {
    let releaseMetadata: (() => void) | undefined;
    const metadataBlocked = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts/${artifactId}`,
        async () => {
          await metadataBlocked;
          return HttpResponse.json({
            id: artifactId,
            workspaceId,
            byteLength: 12,
            mediaType: 'application/json',
            sha256: 'a'.repeat(64),
            status: 'available',
            createdAt: '2026-09-14T10:00:00.000Z',
            expiresAt: null,
          });
        },
      ),
    );
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    const rendered = render(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={apiClient}
          workspaceId={workspaceId}
          artifactId={artifactId}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Prepare download' }),
    );
    rendered.rerender(
      <QueryClientProvider client={createQueryClient()}>
        <ArtifactDownload
          apiClient={apiClient}
          workspaceId={workspaceId}
          artifactId={secondArtifactId}
        />
      </QueryClientProvider>,
    );
    releaseMetadata?.();
    expect(await screen.findByText(secondArtifactId)).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Download artifact' }),
    ).not.toBeInTheDocument();
  });
});
