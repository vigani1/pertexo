import {
  createWorkflowNodeFixture,
  createWorkflowEdgeFixture,
} from '../../../test/support/fixtures/graph';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import {
  noticePreferencesResponseSchema,
  workspaceInboxListResponseSchema,
} from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

test('personal schedules survive exact retry, real failures reach Inbox and SMTP, and private mute/unsubscribe leave runs alone', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Owned mail missing');
  await registerEditorUser(page, request, origin, 'Notification owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Notification qualification',
  );
  const preferencePath = `/v1/workspaces/${workspaceId}/notifications/preferences`;
  await page.goto(`/w/${workspaceId}/settings/notifications`);
  const personal = page.getByRole('region', {
    name: 'Your email',
    exact: true,
  });
  await personal.getByRole('combobox', { name: 'Email frequency' }).click();
  await page.getByRole('option', { name: 'Daily digest', exact: true }).click();
  await personal
    .getByRole('textbox', { name: 'Time zone' })
    .fill('Europe/Paris');
  let intercepted = false;
  const writes: { body: string | null; key: string | undefined }[] = [];
  await page.route(`**${preferencePath}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    if (intercepted) return route.continue();
    intercepted = true;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    return route.fulfill({ status: 502, body: '' });
  });
  await personal
    .getByRole('button', { name: 'Save choices', exact: true })
    .click();
  await personal
    .getByRole('button', { name: 'Retry same save', exact: true })
    .click();
  await expect(
    personal.getByText('Notification choices saved', { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await page.unroute(`**${preferencePath}`);
  const daily = noticePreferencesResponseSchema.parse(
    await (await page.request.get(preferencePath)).json(),
  );
  expect(daily).toMatchObject({
    revision: 1,
    mode: 'daily',
    timeZone: 'Europe/Paris',
    hour: 9,
  });
  await mkdir('/tmp/pertexo-notification-screenshots', { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: '/tmp/pertexo-notification-screenshots/settings-1280.png',
    fullPage: true,
  });
  await personal.getByRole('combobox', { name: 'Email frequency' }).click();
  await page.getByRole('option', { name: 'Immediate', exact: true }).click();
  await personal
    .getByRole('button', { name: 'Save choices', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        noticePreferencesResponseSchema.parse(
          await (await page.request.get(preferencePath)).json(),
        ).revision,
    )
    .toBe(2);
  const workflowName = 'Private inputs stay out';
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    workflowName,
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const draft = await page.request.get(`${workflowPath}/draft`);
  expect(draft.status()).toBe(200);
  const graph = {
    settings: { maxRunDurationMs: 60000 },
    nodes: [
      createWorkflowNodeFixture({
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
      }),
      {
        ...createWorkflowNodeFixture({
          id: 'summary',
          definition: { key: 'core.summarize', version: 1 },
          position: { x: 260, y: 0 },
        }),
        config: { valuePath: '$', missing: 'error' },
        inputMappings: { items: { kind: 'literal', value: ['not a number'] } },
      },
      createWorkflowNodeFixture({
        id: 'finish',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 520, y: 0 },
      }),
    ],
    edges: [
      createWorkflowEdgeFixture({ source: 'manual', target: 'summary' }),
      createWorkflowEdgeFixture({ source: 'summary', target: 'finish' }),
    ],
  };
  const saved = await page.request.put(`${workflowPath}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await readCsrfToken(page),
    },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, {
    private: 'NEVER_MAIL_BROWSER_INPUT',
  });
  await waitForRun(page, workspaceId, runId, 'failed');
  await expect
    .poll(
      async () =>
        workspaceInboxListResponseSchema.parse(
          await (
            await page.request.get(
              `/v1/workspaces/${workspaceId}/notifications`,
            )
          ).json(),
        ).items.length,
    )
    .toBe(1);
  await page.goto(`/w/${workspaceId}/inbox`);
  const notices = page.getByRole('list', { name: 'Notices', exact: true });
  await expect(
    notices.getByRole('link', { name: `${workflowName}, unread`, exact: true }),
  ).toBeVisible();
  await expect(notices.getByText(/^Failed once ·/u)).toBeVisible();
  await page.screenshot({
    path: '/tmp/pertexo-notification-screenshots/inbox-1280.png',
    fullPage: true,
  });
  let text = '';
  await expect
    .poll(async () => {
      const response = await request.get(`${origin}/notice-mail`);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { messages: string[] };
      text = body.messages[0] ?? '';
      return body.messages.length;
    })
    .toBe(1);
  expect(text).toContain(workflowName);
  expect(text).not.toContain('NEVER_MAIL');
  const link =
    /https?:\/\/[^\s]+\/notifications\/unsubscribe#[A-Za-z0-9_-]+/u.exec(
      text,
    )?.[0];
  if (link === undefined) throw new Error('Unsubscribe link missing');
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}/settings`);
  await page
    .getByRole('button', { name: 'Personal notifications…', exact: true })
    .click();
  const choices = page.getByRole('dialog', {
    name: `Notifications for ${workflowName}`,
    exact: true,
  });
  await choices
    .getByRole('checkbox', { name: 'Follow this workflow', exact: true })
    .check();
  await choices
    .getByRole('button', { name: 'Save personal choices', exact: true })
    .click();
  await expect(
    choices.getByText('Notification choices saved', { exact: true }),
  ).toBeVisible();
  await choices
    .getByRole('checkbox', { name: 'Mute its notices for me', exact: true })
    .check();
  await choices
    .getByRole('button', { name: 'Save personal choices', exact: true })
    .click();
  await expect(
    choices.getByText('Notification choices saved', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`/w/${workspaceId}/inbox`);
  await expect(
    page.getByRole('heading', { name: 'Everything finished', exact: true }),
  ).toBeVisible();
  const stillFailed = await waitForRun(page, workspaceId, runId, 'failed');
  expect(stillFailed.run.status).toBe('failed');
  const anonymous = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const confirmation = await anonymous.newPage();
    await confirmation.goto(link);
    await expect(
      confirmation.getByRole('heading', {
        name: 'Turn off personal email?',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      noticePreferencesResponseSchema.parse(
        await (await page.request.get(preferencePath)).json(),
      ),
    ).toMatchObject({ revision: 2, mode: 'immediate' });
    const capability = new URL(link).hash.slice(1);
    const oneClick = `/v1/notifications/unsubscribe/one-click?token=${capability}`;
    const scanner = await anonymous.request.get(oneClick, { maxRedirects: 0 });
    expect(scanner.status()).toBe(303);
    expect(scanner.headers().location).toBe(
      `/notifications/unsubscribe#${capability}`,
    );
    expect(
      noticePreferencesResponseSchema.parse(
        await (await page.request.get(preferencePath)).json(),
      ),
    ).toMatchObject({ revision: 2, mode: 'immediate' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const optOut = await anonymous.request.post(oneClick, {
        form: { 'List-Unsubscribe': 'One-Click' },
        maxRedirects: 0,
      });
      expect(optOut.status(), await optOut.text()).toBe(200);
      expect(optOut.headers().location).toBeUndefined();
    }
    expect(
      noticePreferencesResponseSchema.parse(
        await (await page.request.get(preferencePath)).json(),
      ),
    ).toMatchObject({ revision: 3, mode: 'off' });
    await confirmation
      .getByRole('button', { name: 'Turn off personal email', exact: true })
      .click();
    await expect(
      confirmation.getByText('Personal notification email is off', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await anonymous.close();
  }
  await page.setViewportSize({ width: 375, height: 768 });
  await page.goto(`/w/${workspaceId}/settings/notifications`);
  await expect(
    page.getByRole('region', { name: 'Your email' }).getByRole('combobox'),
  ).toHaveText('Off');
  expect(
    noticePreferencesResponseSchema.parse(
      await (await page.request.get(preferencePath)).json(),
    ),
  ).toMatchObject({ revision: 3, mode: 'off' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/pertexo-notification-screenshots/settings-375.png',
    fullPage: true,
  });
});
