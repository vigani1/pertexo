// @vitest-environment-options {"url":"https://pertexo.test"}
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/components/ui/toast';
import { SamlMetadata } from '@/features/federation/components/providers/metadata';
import { createApiClient } from '@/lib/api/client';
import { json, organization, workspaceId, userId } from './fixtures';
afterEach(() => {
  vi.restoreAllMocks();
});
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const apiClient = createApiClient({ fetch, readCsrfToken: () => undefined });
  render(
    <NotificationsProvider>
      <SamlMetadata
        scope={{ apiClient, workspaceId, userId }}
        organizationId={organization.id}
      />
    </NotificationsProvider>,
  );
  return { fetch };
}
/** What the browser was asked to save: each file's name and text. */
function watchDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (blob instanceof Blob) blobs.push(blob);
    return 'blob:metadata';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return {
    names,
    texts: () => Promise.all(blobs.map((blob) => blob.text())),
    types: () => blobs.map((blob) => blob.type),
  };
}

describe('SAML metadata before provider setup', () => {
  it('downloads only successful metadata through the existing authenticated client', async () => {
    const { fetch } = fixture(),
      saved = watchDownloads();
    fetch.mockResolvedValueOnce(
      json({
        entityId: `https://pertexo.test/v1/auth/federation/saml/organizations/${organization.id}`,
        redirectUri: 'https://pertexo.test/v1/auth/federation/saml/callback',
        xml: '<EntityDescriptor>public metadata</EntityDescriptor>',
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('SAML setup and metadata'));
    expect(screen.getByText(new RegExp(organization.id, 'u'))).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Download SP metadata' }),
    );
    await waitFor(() => {
      expect(saved.names).toEqual(['pertexo-saml.xml']);
    });
    expect(await saved.texts()).toEqual([
      '<EntityDescriptor>public metadata</EntityDescriptor>',
    ]);
    expect(saved.types()).toEqual(['application/samlmetadata+xml']);
    expect(fetch.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(
        `/v1/workspaces/${workspaceId}/sso/saml/metadata`,
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Download SP metadata' }),
    ).toBeEnabled();
  });
  it('keeps a failed download on the page with visible feedback instead of saving an error as XML', async () => {
    const { fetch } = fixture(),
      saved = watchDownloads();
    fetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const user = userEvent.setup();
    await user.click(screen.getByText('SAML setup and metadata'));
    await user.click(
      screen.getByRole('button', { name: 'Download SP metadata' }),
    );
    expect(await screen.findByRole('status')).toBeVisible();
    expect(saved.names).toEqual([]);
  });
});
