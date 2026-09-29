import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const importId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const billingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const csrfToken = 'csrf-token-for-inbox-browser-tests-12345678901234';
const timestamp = '2026-09-15T10:00:00.000Z';

type Thread = Readonly<{
  workflowId: string;
  workflowName: string;
  kind: 'failed' | 'timed_out' | 'outcome_unknown';
  occurrenceCount: number;
  firstOccurredAt: string;
  latestOccurredAt: string;
  latestRunId: string;
  latestFailedStep: null;
  revision: string;
  unread: boolean;
}>;

function thread(workflowId: string, workflowName: string): Thread {
  return {
    workflowId,
    workflowName,
    kind: 'failed',
    occurrenceCount: 2,
    firstOccurredAt: '2026-09-15T09:00:00.000000Z',
    latestOccurredAt: '2026-09-15T09:30:00.000000Z',
    latestRunId: runId,
    latestFailedStep: null,
    revision: '7',
    unread: true,
  };
}

/** An operator's workspace whose inbox holds two unread failing workflows. */
async function mockInbox(page: Page) {
  const state = {
    threads: [
      thread(importId, 'Nightly import'),
      thread(billingId, 'Billing sync'),
    ],
    reads: [] as { workflowId: string; revision: unknown; csrf?: string }[],
  };
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'operator@example.test',
        displayName: 'Workspace Operator',
        status: 'active',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            revision: 1,
            role: 'operator',
            capabilities: [
              'workspace:read',
              'workflow:read',
              'notification:read',
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  const base = `**/v1/workspaces/${workspaceId}/notifications`;
  await page.route(`${base}/events`, (route) =>
    route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: inbox.ready\ndata: {"schemaVersion":1,"revision":null}\n\n',
    }),
  );
  await page.route(`${base}/summary`, (route) =>
    route.fulfill({
      json: {
        unreadCount: state.threads.filter((item) => item.unread).length,
        revision: '7',
      },
    }),
  );
  await page.route(`${base}?**`, (route) =>
    route.fulfill({
      json: { items: state.threads, nextCursor: null, revision: '7' },
    }),
  );
  await page.route(`${base}/*/read`, async (route) => {
    const request = route.request();
    const workflowId = new URL(request.url()).pathname.split('/').at(-2) ?? '';
    const body = request.postDataJSON() as { revision: unknown };
    state.reads.push({
      workflowId,
      revision: body.revision,
      ...(request.headers()['x-csrf-token'] === undefined
        ? {}
        : { csrf: request.headers()['x-csrf-token'] }),
    });
    state.threads = state.threads.map((item) =>
      item.workflowId === workflowId ? { ...item, unread: false } : item,
    );
    await route.fulfill({
      json: { workflowId, unread: false, revision: '7' },
    });
  });
  return state;
}

test('shows the unread count and marks a failing workflow read', async ({
  page,
}) => {
  const state = await mockInbox(page);
  await page.goto(`/w/${workspaceId}`);
  const spine = page.getByRole('navigation', { name: 'Workspace' }).first();
  await spine.getByRole('link', { name: 'Inbox, 2 unread' }).click();

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Failing workflows' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(
    list.getByRole('link', { name: 'Nightly import, unread' }),
  ).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);

  await page.getByRole('button', { name: 'Mark Nightly import read' }).click();
  await expect(
    spine.getByRole('link', { name: 'Inbox, 1 unread' }),
  ).toBeVisible();
  expect(state.reads).toEqual([
    { workflowId: importId, revision: '7', csrf: csrfToken },
  ]);
  await expect(
    list.getByRole('link', { name: 'Nightly import', exact: true }),
  ).toBeVisible();
});

test('keeps the inbox usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockInbox(page);
  await page.goto(`/w/${workspaceId}/inbox`);

  const bar = page.getByRole('navigation', { name: 'Workspace' }).last();
  await expect(
    bar.getByRole('link', { name: 'Inbox, 2 unread' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Billing sync, unread' }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
