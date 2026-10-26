import { test, expect } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
  user,
} from '../workflow-editor/support';
const taskId = '11111111-1111-4111-8111-111111111111';
const task = {
  id: taskId,
  workspaceId,
  workflowId,
  workflowName: 'Payment review',
  workflowVersionId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  nodeId: 'approval',
  nodeRunId: '44444444-4444-4444-8444-444444444444',
  iterationPath: [],
  kind: 'approval',
  title: 'Review payment',
  instructions: 'Check the amount before deciding.',
  details: { Amount: 120, Ready: false, Note: '<b>Plain text</b>' },
  audience: { roles: ['owner', 'admin'], memberIds: [] },
  status: 'pending',
  createdAt: '2026-10-15T08:00:00.000Z',
  expiresAt: '2026-10-22T08:00:00.000Z',
  onExpiry: 'fail',
  completedAt: null,
  completedByName: null,
  output: null,
  canRespond: true,
  blockedReason: null,
};
for (const width of [1280, 375])
  test(`preserves an uncertain decision and its key at ${String(width)}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft());
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: 'csrf-approval-browser-123456789012345678901234567890',
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    const writes: { body: unknown; key: string | undefined }[] = [];
    const resolved = {
      ...task,
      status: 'approved',
      canRespond: false,
      blockedReason: 'resolved',
      completedAt: '2026-10-15T09:00:00.000Z',
      completedByName: user.displayName,
      output: {
        decision: 'approved',
        comment: 'Ready to send',
        decidedBy: user.id,
        decidedAt: '2026-10-15T09:00:00.000Z',
      },
    };
    await page.route(`**/pending-tasks/${taskId}`, (route) =>
      route.fulfill({ json: { task: writes.length === 0 ? task : resolved } }),
    );
    await page.route(`**/pending-tasks/${taskId}/decide`, async (route) => {
      writes.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      expect(route.request().headers()['x-csrf-token']).toBeTruthy();
      if (writes.length === 1) return route.abort('failed');
      return route.fulfill({ json: { task: resolved, replayed: true } });
    });
    await page.goto(`/w/${workspaceId}/approvals/${taskId}`);
    await expect(
      page.getByRole('heading', { name: 'Review payment', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('definition').filter({ hasText: '<b>Plain text</b>' }),
    ).toBeVisible();
    await expect(
      page.locator('b').filter({ hasText: 'Plain text' }),
    ).toHaveCount(0);
    await page
      .getByLabel('Comment (optional)', { exact: true })
      .fill('Ready to send');
    await page.getByRole('button', { name: 'Approve', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(/We couldn’t confirm the decision/u),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Retry same decision', exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: `${user.displayName} approved this request`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(/We couldn’t confirm the decision/u),
    ).toBeHidden();
    await expect(page.getByText(/already has a final result/u)).toBeHidden();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toEqual({
      decision: 'approved',
      comment: 'Ready to send',
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test('explains why the starter cannot decide and sends no command', async ({
  page,
}) => {
  await installEditorRoutes(page, remoteDraft());
  await page.route(`**/pending-tasks/${taskId}`, (route) =>
    route.fulfill({
      json: { task: { ...task, canRespond: false, blockedReason: 'starter' } },
    }),
  );
  await page.goto(`/w/${workspaceId}/approvals/${taskId}`);
  await expect(
    page.getByText(/The person who started this run cannot decide/u),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reject', exact: true }),
  ).toBeDisabled();
});
/** A request as the queue lists it: the detail fields stay on its page. */
function listed(detail: Record<string, unknown>) {
  const summary = { ...detail };
  for (const field of [
    'instructions',
    'audience',
    'output',
    'workflowVersionId',
  ])
    Reflect.deleteProperty(summary, field);
  return summary;
}

for (const width of [1280, 375])
  test(`decides a waiting approval from the queue at ${String(width)}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await installEditorRoutes(page, remoteDraft());
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: 'csrf-approval-browser-123456789012345678901234567890',
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    const decided = listed({
      ...task,
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Refund the order',
      status: 'approved',
      canRespond: false,
      blockedReason: 'resolved',
      completedAt: '2026-10-15T09:00:00.000Z',
      completedByName: 'Ada Admin',
    });
    let waiting = true;
    await page.route(
      `**/v1/workspaces/${workspaceId}/pending-tasks?**`,
      (route) =>
        route.fulfill({
          json: {
            items: waiting ? [listed(task), decided] : [decided],
            nextCursor: null,
            pendingCount: waiting ? 1 : 0,
          },
        }),
    );
    const writes: unknown[] = [];
    await page.route(`**/pending-tasks/${taskId}/decide`, (route) => {
      writes.push(route.request().postDataJSON());
      waiting = false;
      return route.fulfill({
        json: {
          task: {
            ...task,
            status: 'approved',
            canRespond: false,
            blockedReason: 'resolved',
            completedAt: '2026-10-15T09:00:00.000Z',
            completedByName: user.displayName,
            output: {
              decision: 'approved',
              comment: null,
              decidedBy: user.id,
              decidedAt: '2026-10-15T09:00:00.000Z',
            },
          },
          replayed: false,
        },
      });
    });
    await page.goto(`/w/${workspaceId}/requests?kind=all&view=all&status=all`);
    // A finished request says who ended it and offers no decision.
    await expect(
      page.getByText('Ada Admin approved', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve Refund the order' }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Approve Review payment', exact: true })
      .click();
    await expect
      .poll(() => writes)
      .toEqual([{ decision: 'approved', comment: '' }]);
    await expect(
      page.getByRole('button', { name: 'Approve Review payment', exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
