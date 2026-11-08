import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';
const destinationId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const destination = {
  id: destinationId,
  workspaceId,
  kind: 'email',
  status: 'enabled',
  currentVersion: 1,
  config: { kind: 'email', connectionId, toEmail: 'alerts@example.test' },
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
for (const width of [375, 1280])
  test(`recovers an accepted alert clear independently of Off at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(
      page,
      remoteDraft({ nodes: [], edges: [], settings: {} }),
    );
    const clears: (string | undefined)[] = [];
    const sets: { key: string | undefined; body: unknown }[] = [];
    await page.route(
      `**/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      (route) => route.fulfill({ json: { items: [destination] } }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/failure-notification-policy`,
      async (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({
            json: { destination: clears.length === 0 ? destination : null },
          });
        if (route.request().method() === 'DELETE') {
          clears.push(route.request().headers()['idempotency-key']);
          if (clears.length === 1) return route.abort('failed');
          return route.fulfill({ status: 204 });
        }
        sets.push({
          key: route.request().headers()['idempotency-key'],
          body: route.request().postDataJSON() as unknown,
        });
        return route.fulfill({ json: { destination } });
      },
    );
    await page.goto(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const alerts = page.getByRole('region', {
      name: 'Failure alerts',
      exact: true,
    });
    await alerts.getByRole('button', { name: 'Turn alerts off' }).click();
    await expect(alerts.getByText(/aren’t announced anywhere/u)).toBeVisible();
    await expect(
      alerts.getByRole('button', { name: 'Turn alerts off' }),
    ).toBeDisabled();
    await alerts
      .getByRole('combobox', { name: 'Send failure alerts to' })
      .click();
    await page
      .getByRole('option', { name: 'Email to alerts@example.test' })
      .click();
    await alerts
      .getByRole('button', { name: 'Retry same alert change' })
      .click();
    await expect(
      alerts.getByRole('button', { name: 'Retry same alert change' }),
    ).toHaveCount(0);
    await expect(
      alerts.getByRole('combobox', { name: 'Send failure alerts to' }),
    ).toContainText('Email to alerts@example.test');
    await alerts.getByRole('button', { name: 'Save destination' }).click();
    await expect.poll(() => sets.length).toBe(1);
    expect(clears).toHaveLength(2);
    expect(clears[1]).toBe(clears[0]);
    expect(sets[0]?.body).toEqual({ destinationId });
    expect(sets[0]?.key).not.toBe(clears[0]);
  });
