import { test, expect } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  addCsrfCookie,
} from '../workflow-editor/support';
for (const width of [1280, 375])
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
    await expect(
      page.getByText('workspace.created', { exact: true }),
    ).toBeVisible();
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
    await page.getByLabel('Person name').fill('Nobody');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      page.getByText('No events match these filters.', { exact: true }),
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
