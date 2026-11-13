import { expectFitsAndTappable } from '../support/accessibility';
import { test, expect } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  addCsrfCookie,
} from '../workflow-editor/support';
for (const width of [1280, 360])
  test(`audit filters and retention preserve an uncertain save at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        role: 'owner',
        capabilities: [
          ...workspace.capabilities,
          'audit:read',
          'governance:manage',
        ],
      },
    });
    await addCsrfCookie(context);
    const root = `/v1/workspaces/${workspaceId}/governance`;
    const writes: { body: unknown; key: string | undefined }[] = [];
    let revision = 1,
      days = 365;
    await page.route(`**${root}/settings`, async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { revision, auditRetentionDays: days } });
      writes.push({
        body: route.request().postDataJSON() as unknown,
        key: route.request().headers()['idempotency-key'],
      });
      if (writes.length === 1)
        return route.fulfill({
          status: 502,
          json: {
            type: 'about:blank',
            title: 'Gateway lost response',
            status: 502,
            code: 'internal.unexpected',
            requestId: 'audit-save',
          },
        });
      revision = 2;
      days = 30;
      return route.fulfill({ json: { revision, auditRetentionDays: days } });
    });
    await page.route(`**${root}/audit?*`, (route) => {
      const query = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: {
          items:
            query.get('person') === 'Nobody'
              ? []
              : [
                  {
                    id: '10000000-0000-4000-8000-000000000001',
                    actorId: null,
                    actorName: null,
                    action: 'workspace.created',
                    targetType: 'workspace',
                    targetId: workspaceId,
                    occurredAt: '2026-10-17T10:00:00.000Z',
                    metadata: {},
                  },
                ],
          nextCursor: null,
        },
      });
    });
    await page.goto(`/w/${workspaceId}/settings/audit`);
    // Events read as sentences; the recorded action stays in the details.
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await expect(page.getByText('created the workspace')).toBeVisible();
    await expect(
      page.getByText('workspace.created', { exact: true }),
    ).toBeHidden();
    await expectFitsAndTappable(page);
    await page.getByLabel('Keep audit events (days)').fill('30');
    await page
      .getByRole('button', { name: 'Save retention', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Retry same save', exact: true })
      .click();
    await expect(
      page.getByText('Retention saved.', { exact: true }),
    ).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    await page.getByRole('searchbox', { name: 'Person' }).fill('Nobody');
    await page.getByRole('searchbox', { name: 'Person' }).press('Enter');
    await expect(
      page.getByText('Nothing matches. Widen the dates or clear a filter.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(/person=Nobody/u);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  });

for (const width of [1280, 375]) {
  test(`retains a step test’s unknown outcome and real mode at ${String(width)}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        role: 'owner',
        capabilities: [
          ...workspace.capabilities,
          'audit:read',
          'governance:manage',
        ],
      },
    });
    const root = `**/v1/workspaces/${workspaceId}/governance`;
    await page.route(`${root}/settings`, (route) =>
      route.fulfill({ json: { revision: 1, auditRetentionDays: 365 } }),
    );
    await page.route(`${root}/audit?*`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              actorId: null,
              actorName: null,
              action: 'preview.execution_terminal',
              targetType: 'preview-run',
              targetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              occurredAt: new Date().toISOString(),
              metadata: { status: 'outcome_unknown', dryRun: 'not_supported' },
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.goto(`/w/${workspaceId}/settings/audit`);
    await expect(page.getByText(/Outcome unknown/u)).toBeVisible();
    await expect(page.getByText(/Runs for real/u)).toBeVisible();
    await page.screenshot({
      path: info.outputPath('preview-audit.png'),
      fullPage: true,
    });
  });
}

for (const width of [375, 1280])
  test(`recovers a refused native audit export in its download tab at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        capabilities: [...workspace.capabilities, 'audit:read'],
      },
    });
    await addCsrfCookie(context);
    const root = `/v1/workspaces/${workspaceId}/governance`;
    await context.route(`**${root}/audit?*`, (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await context.route(`**${root}/settings`, (route) =>
      route.fulfill({ json: { revision: 1, auditRetentionDays: 365 } }),
    );
    let exports = 0;
    await context.route(`**${root}/audit/export`, (route) => {
      exports++;
      expect(route.request().method()).toBe('POST');
      const body = new URLSearchParams(route.request().postData() ?? '');
      expect(body.get('csrfToken')).toBeTruthy();
      expect(body.get('payload')).toBe('{}');
      return exports === 1
        ? route.fulfill({
            status: 503,
            contentType: 'text/html; charset=utf-8',
            headers: {
              'content-security-policy':
                "default-src 'none'; frame-ancestors 'none'; sandbox",
            },
            body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Audit export couldn’t be downloaded</h1><p>The download could not be completed. Return to Audit and try exporting again.</p><p>Error ID: <code>export-support-id</code></p><a href="/w/${workspaceId}/settings/audit">Return to Audit to try again</a></main></body></html>`,
          })
        : route.fulfill({
            status: 200,
            headers: {
              'content-type': 'text/csv',
              'content-disposition': 'attachment; filename="audit.csv"',
            },
            body: 'action\nworkspace.created\n',
          });
    });
    await page.goto(`/w/${workspaceId}/settings/audit`);
    const opened = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const failure = await opened;
    await expect(
      failure.getByRole('heading', {
        name: 'Audit export couldn’t be downloaded',
      }),
    ).toBeVisible();
    await expect(
      failure.getByText('export-support-id', { exact: true }),
    ).toBeVisible();
    await expect(failure.getByText('internal.unexpected')).toHaveCount(0);
    await expect(
      failure.getByRole('link', { name: 'Return to Audit to try again' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/settings/audit`);
    await failure.close();
    const completed = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await completed;
    expect(download.suggestedFilename()).toBe('audit.csv');
    expect(await download.failure()).toBeNull();
    expect(exports).toBe(2);
  });
