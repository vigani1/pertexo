import { expect, request as httpRequest } from '@playwright/test';
import {
  apiTokenCredentialSchema,
  apiTokenListResponseSchema,
  userProfileResponseSchema,
} from '@pertexo/contracts';
import { test } from './support/browser-fixture';
import { withOwnedCredential } from './support/automation/credential-action';
import {
  registerEditorUser,
  createEditorWorkspace,
} from './support/ordinary-editor-session';

test('issues a personal token through Settings, authenticates without cookies, and revokes at desktop and phone widths', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Owned mail fixture is required');
  const owners: {
    workspaceId: string;
    ownerUserId: string;
    tokenId: string;
  }[] = [];
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await registerEditorUser(
      page,
      request,
      mailOrigin,
      `Automation ${String(width)}`,
    );
    const workspaceId = await createEditorWorkspace(
      page,
      `Automation ${String(width)}`,
    );
    const me = await page.request.get('/v1/users/me');
    expect(me.ok()).toBe(true);
    const ownerUserId = userProfileResponseSchema.parse(await me.json()).id;
    await page.goto(`/w/${workspaceId}/settings/api-tokens`);
    const owner = await withOwnedCredential(async () => {
      await page
        .getByRole('button', { name: 'Create token', exact: true })
        .click();
      await page
        .getByLabel('Token name', { exact: true })
        .fill('Live build runner');
      await page
        .getByRole('checkbox', { name: 'Read workflows', exact: true })
        .check();
      await page
        .getByRole('checkbox', { name: 'Read runs', exact: true })
        .check();
      await page
        .getByRole('button', { name: 'Create token', exact: true })
        .click();
      const secretField = page.getByLabel('API token secret', { exact: true });
      await expect(secretField).toBeVisible();
      const credential = apiTokenCredentialSchema.parse(
        await secretField.inputValue(),
      );
      const [, storedWorkspaceId, tokenId] = credential.split('.');
      if (storedWorkspaceId !== workspaceId || tokenId === undefined)
        throw new Error(
          'Credential routing identifiers do not match the issuing workspace',
        );
      await page
        .getByRole('checkbox', { name: 'I’ve saved this token', exact: true })
        .check();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(secretField).toHaveCount(0);
      const machine = await httpRequest.newContext({
        baseURL: new URL(page.url()).origin,
        extraHTTPHeaders: { Authorization: `Bearer ${credential}` },
      });
      try {
        expect(
          (
            await machine.get(`/v1/workspaces/${workspaceId}/workflows`)
          ).status(),
        ).toBe(200);
        expect(
          (await machine.get(`/v1/workspaces/${workspaceId}/runs`)).status(),
        ).toBe(200);
        expect(
          (
            await machine.get(`/v1/workspaces/${workspaceId}/api-tokens`)
          ).status(),
        ).toBe(401);
        const scopeDenied = await machine.post(
          `/v1/workspaces/${workspaceId}/workflows/import/preview`,
          { data: {} },
        );
        expect(scopeDenied.status()).toBe(404);
        expect(await scopeDenied.json()).toMatchObject({
          code: 'resource.not_found',
        });
        await page
          .getByRole('button', {
            name: 'Revoke Live build runner',
            exact: true,
          })
          .click();
        await page
          .getByRole('button', { name: 'Revoke token', exact: true })
          .click();
        await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
        const denied = await machine.get(
          `/v1/workspaces/${workspaceId}/workflows`,
        );
        expect(denied.status()).toBe(401);
        expect(denied.headers()['www-authenticate']).toBe(
          'Bearer realm="pertexo", error="invalid_token"',
        );
      } finally {
        await machine.dispose();
      }
      await page.reload();
      await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
      await expect(
        page.getByLabel('API token secret', { exact: true }),
      ).toHaveCount(0);
      const listed = await page.request.get(
        `/v1/workspaces/${workspaceId}/api-tokens`,
      );
      expect(
        apiTokenListResponseSchema.parse(await listed.json()).items,
      ).toHaveLength(1);
      return { workspaceId, ownerUserId, tokenId };
    });
    owners.push(owner);
    await page.goto('/logout');
    await expect(
      page.getByRole('heading', { name: 'Sign in to continue', exact: true }),
    ).toBeVisible();
  }
  const evidence = await request.post(`${mailOrigin}/evidence/api-tokens`, {
    data: { owners },
  });
  expect(evidence.status()).toBe(204);
});
