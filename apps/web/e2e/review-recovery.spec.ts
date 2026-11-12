import type { FederationSettings, WorkflowFolder } from '@pertexo/contracts';
import { settings, organization } from '../test/features/federation/fixtures';
import { expect, test } from './support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workspace,
} from './workflow-editor/support';
import { workflowListBody } from './workflows/list-support';

for (const width of [375, 1280]) {
  test(`an unconfirmed workflow creation keeps the name and asks for a new confirmation at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    await addCsrfCookie(context);
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        capabilities: [...workspace.capabilities, 'workflow:create'],
      },
    });
    const keys: (string | undefined)[] = [];
    let listReads = 0;
    await page.route(`**/v1/workspaces/${workspaceId}/workflows**`, (route) => {
      if (route.request().method() === 'POST') {
        keys.push(route.request().headers()['idempotency-key']);
        return route.abort('failed');
      }
      listReads += 1;
      return route.fulfill({
        json: workflowListBody(route.request().url(), []),
      });
    });
    await page.goto(`/w/${workspaceId}/workflows`);
    await page
      .getByRole('button', { name: 'New workflow', exact: true })
      .click();
    const name = page.getByLabel('Workflow name');
    await name.fill('Retained workflow');
    const create = page.getByRole('button', {
      name: 'Create workflow',
      exact: true,
    });
    const readsBeforeCreate = listReads;
    await create.click();
    await expect(page.getByText(/couldn’t confirm that change/u)).toBeVisible();
    await expect.poll(() => listReads).toBeGreaterThan(readsBeforeCreate);
    await expect(name).toHaveValue('Retained workflow');
    await expect(create).toBeEnabled();
    expect(keys).toHaveLength(1);
    await page.screenshot({
      path: test.info().outputPath(`workflow-unconfirmed-${String(width)}.png`),
    });
    await create.click();
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
    await expect(page).toHaveURL(`/w/${workspaceId}/workflows?create=true`);
  });
}

for (const width of [375, 1280]) {
  for (const kind of ['oidc', 'saml'] as const) {
    test(`${kind} conflict read retries inside the dialog at ${String(width)}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
      await addCsrfCookie(context);
      await installEditorRoutes(page, remoteDraft(), {
        accessibleWorkspace: {
          ...workspace,
          capabilities: [...workspace.capabilities, 'member:read'],
        },
      });
      const oidc = settings.organization?.providers[0];
      if (oidc === undefined) throw new Error('Provider fixture missing');
      const provider =
        kind === 'oidc'
          ? oidc
          : {
              id: oidc.id,
              name: oidc.name,
              enabled: oidc.enabled,
              revision: oidc.revision,
              kind: 'saml' as const,
              issuer: 'https://idp.example.test/entity',
              configuration: {
                signInUrl: 'https://idp.example.test/sso',
                certificates: ['browser-public-certificate'],
                emailAttribute: 'email',
                nameAttribute: 'name',
                jitEnabled: false,
              },
            };
      let current: FederationSettings = {
        ...settings,
        organization: { ...organization, providers: [provider] },
      };
      let failedRead = false;
      const bodies: unknown[] = [];
      const base = `**/v1/workspaces/${workspaceId}/sso`;
      await page.route(base, (route) => {
        if (bodies.length === 1 && !failedRead) {
          failedRead = true;
          return route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Unavailable',
              status: 503,
              code: 'internal.unexpected',
              requestId: 'provider-current-read-failed',
            },
          });
        }
        return route.fulfill({ json: current });
      });
      await page.route(`${base}/providers/${provider.id}`, (route) => {
        bodies.push(route.request().postDataJSON());
        if (bodies.length === 1) {
          current = {
            ...current,
            organization: {
              ...organization,
              providers: [provider],
              revision: 2,
            },
          };
          return route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Changed',
              status: 409,
              code: 'workspace.conflict',
              requestId: 'provider-refused',
            },
          });
        }
        return route.fulfill({ json: current });
      });
      await page.goto(`/w/${workspaceId}/settings/sso`);
      await page
        .getByRole('button', { name: 'Edit provider', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: `Edit ${kind.toUpperCase()} provider`,
        exact: true,
      });
      await dialog.getByLabel('Provider name').fill('My retained browser name');
      if (kind === 'oidc')
        await dialog
          .getByLabel('Client secret')
          .fill('browser-retained-secret');
      else
        await dialog
          .getByLabel('SSO sign-in URL')
          .fill('https://retained.example.test/sso');
      await dialog
        .getByRole('button', { name: 'Save provider', exact: true })
        .click();
      const review = dialog.getByRole('button', {
        name: 'Keep edits and use latest revision',
      });
      await expect(
        dialog.getByText('provider-current-read-failed', { exact: true }),
      ).toBeVisible();
      await expect(review).toBeDisabled();
      await page.screenshot({
        path: test
          .info()
          .outputPath(`${kind}-read-failure-${String(width)}.png`),
      });
      await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(review).toBeEnabled();
      await expect(dialog.getByLabel('Provider name')).toHaveValue(
        'My retained browser name',
      );
      if (kind === 'oidc')
        await expect(dialog.getByLabel('Client secret')).toHaveValue(
          'browser-retained-secret',
        );
      else
        await expect(dialog.getByLabel('SSO sign-in URL')).toHaveValue(
          'https://retained.example.test/sso',
        );
      await review.click();
      await dialog
        .getByRole('button', { name: 'Save provider', exact: true })
        .click();
      await expect.poll(() => bodies.length).toBe(2);
      expect(bodies[1]).toMatchObject({
        expectedRevision: 2,
        name: 'My retained browser name',
      });
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspaceId}/settings/sso`);
    });
  }
  test(`folder conflict read retries inside the dialog at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    await addCsrfCookie(context);
    await installEditorRoutes(page, remoteDraft());
    const folderId = '22222222-2222-4222-8222-222222222222';
    let folder: WorkflowFolder = {
      id: folderId,
      name: 'Operations',
      revision: 1,
      parentId: null,
      depth: 1,
      accessMode: 'workspace',
    };
    let failedRead = false;
    const bodies: unknown[] = [];
    const base = `**/v1/workspaces/${workspaceId}/workflow-folders`;
    await page.route(base, (route) => {
      if (bodies.length === 1 && !failedRead) {
        failedRead = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Unavailable',
            status: 503,
            code: 'internal.unexpected',
            requestId: 'folder-current-read-failed',
          },
        });
      }
      return route.fulfill({ json: { items: [folder] } });
    });
    await page.route(`${base}/${folderId}/rename`, (route) => {
      bodies.push(route.request().postDataJSON());
      folder = { ...folder, revision: bodies.length + 1 };
      if (bodies.length === 1)
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Changed',
            status: 409,
            code: 'workflow.folder_revision_conflict',
            requestId: 'folder-refused',
          },
        });
      return route.fulfill({ json: { folder, replayed: false } });
    });
    await page.goto(`/w/${workspaceId}/workflows`);
    await page.getByRole('button', { name: 'Actions for Operations' }).click();
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Rename Operations',
      exact: true,
    });
    await dialog.getByLabel('Name', { exact: true }).fill('My retained folder');
    await dialog
      .getByRole('button', { name: 'Save name', exact: true })
      .click();
    const review = dialog.getByRole('button', {
      name: 'Keep edits and use latest revision',
    });
    await expect(
      dialog.getByText('folder-current-read-failed', { exact: true }),
    ).toBeVisible();
    await expect(review).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath(`folder-read-failure-${String(width)}.png`),
    });
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(review).toBeEnabled();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(
      'My retained folder',
    );
    await review.click();
    await dialog
      .getByRole('button', { name: 'Save name', exact: true })
      .click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({
      expectedFolderRevision: 2,
      name: 'My retained folder',
    });
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
  });
}
