import { mkdir } from 'node:fs/promises';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  directorySettingsSchema,
  workspaceIdentifierSchema,
} from '@pertexo/contracts';

export async function provisionDirectory({
  page,
  request,
  workspaceId,
  email,
  width,
}: Readonly<{
  page: Page;
  request: APIRequestContext;
  workspaceId: string;
  email: string;
  width: number;
}>) {
  await page.getByRole('link', { name: 'Directory', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Create provisioning credential',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Credential name', { exact: true })
    .fill('Owned directory');
  await dialog
    .getByRole('button', { name: 'Create credential', exact: true })
    .click();
  const secret = await dialog
    .getByLabel('Provisioning bearer credential', { exact: true })
    .inputValue();
  await dialog
    .getByRole('checkbox', { name: 'I’ve saved this credential', exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const settings = directorySettingsSchema.parse(
    await (
      await page.request.get(`/v1/workspaces/${workspaceId}/sso/directory`)
    ).json(),
  );
  const base = new URL(
    `/v1/auth/federation/scim/${settings.organizationId}/v2`,
    page.url(),
  ).href;
  const headers = {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/scim+json',
  };
  const person = await request.post(`${base}/Users`, {
    headers,
    data: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: email,
      active: true,
      emails: [{ value: email, primary: true }],
    },
  });
  expect(person.status(), await person.text()).toBe(201);
  const created: unknown = await person.json();
  if (typeof created !== 'object' || created === null || !('id' in created))
    throw new Error('Owned directory user missing');
  const userId = workspaceIdentifierSchema.parse(created.id);
  const group = await request.post(`${base}/Groups`, {
    headers,
    data: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Owned builders',
      members: [{ value: userId }],
    },
  });
  expect(group.status(), await group.text()).toBe(201);
  await page.reload();
  await expect(
    page.getByText('Awaiting first SSO', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Directory group', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Owned builders', exact: true })
    .click();
  await page.getByLabel('Role', { exact: true }).click();
  await page.getByRole('option', { name: 'builder', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add group mapping', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Save group mappings', exact: true })
    .click();
  await expect(
    page.getByText('Group mappings saved.', { exact: true }),
  ).toBeVisible();
  await mkdir('/tmp/pertexo-scim-screenshots', { recursive: true });
  await page.screenshot({
    path: `/tmp/pertexo-scim-screenshots/directory-${String(width)}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  return { base, headers, userId };
}

export async function reviewProvisionedMembership(
  page: Page,
  workspaceId: string,
  email: string,
  width: number,
) {
  await page.goto(`/w/${workspaceId}/team`);
  await expect(
    page.getByText(
      'Directory-managed. Ask the organization’s control workspace owner to change access.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/pertexo-scim-screenshots/team-${String(width)}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto(`/w/${workspaceId}/settings/sso?ssoSection=directory`);
  await page
    .getByRole('button', {
      name: `Review membership for ${email}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('This membership is already directory-managed.', {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

export async function deactivateAndRevokeDirectory(
  page: Page,
  request: APIRequestContext,
  directory: Awaited<ReturnType<typeof provisionDirectory>>,
) {
  const inactive = await request.patch(
    `${directory.base}/Users/${directory.userId}`,
    {
      headers: directory.headers,
      data: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      },
    },
  );
  expect(inactive.status(), await inactive.text()).toBe(200);
  await page.reload();
  await expect(page.getByText('Inactive', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Revoke Owned directory', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Revoke credential', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/^Revoked · Created/u)).toBeVisible();
  expect(
    (
      await request.get(`${directory.base}/ServiceProviderConfig`, {
        headers: directory.headers,
      })
    ).status(),
  ).toBe(401);
}
