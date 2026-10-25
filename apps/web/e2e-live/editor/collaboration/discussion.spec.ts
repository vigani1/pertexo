import { readCsrfToken } from '../../../test/support/browser/csrf';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  signInEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  addSingleStep,
  readEditorDraft,
} from '../../support/authoring/single-step';

test('discusses steps, delivers private mentions, preserves refreshes, and warns before a real stale-save race', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  const ownerEmail = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Discussion owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Discussion qualification',
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Our shared workflow',
  );
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const nodeId = await addSingleStep(page, path, /^Manual/u, 'Shared input');
  const editor = `/w/${workspaceId}/workflows/${workflowId}`;
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  let primaryError: unknown;
  try {
    const teammate = await context.newPage();
    teammate.setDefaultTimeout(20000);
    const viewerEmail = await registerEditorUser(
      teammate,
      request,
      mailOrigin,
      'Discussion teammate',
    );
    const setup = await request.post(mailOrigin + '/readonly-setup', {
      data: { workspaceId, workflowId, ownerEmail, viewerEmail },
    });
    expect(setup.status(), await setup.text()).toBe(200);
    const { viewerId } = (await setup.json()) as { viewerId: string };
    await teammate.goto(editor + '/comments');
    await page
      .getByRole('button', { name: 'Step actions', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Discuss this step', exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp('/comments\\?step=' + nodeId + '$', 'u'),
    );
    await page
      .getByRole('textbox', { name: 'New discussion', exact: true })
      .fill('Can you review this input?');
    await page.getByRole('button', { name: '@ Mention', exact: true }).click();
    await page
      .getByRole('button', { name: 'Discussion teammate', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    await expect(
      page.getByText('Can you review this input?', { exact: true }),
    ).toBeVisible();
    await teammate.goto(`/w/${workspaceId}/inbox`);
    await teammate
      .getByRole('link', { name: 'Open discussion', exact: true })
      .click({ timeout: 30000 });
    await expect(
      teammate.getByText('Can you review this input?', { exact: true }),
    ).toBeVisible();
    await teammate
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Reader reply is allowed.');
    await teammate
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    await expect(
      teammate.getByText('Reader reply is allowed.', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('An unfinished reply survives refreshes.');
    const refresh = page.waitForResponse(
      (response) =>
        response.url().includes('/comments/') &&
        response.request().method() === 'GET' &&
        !response.url().includes('/people'),
      { timeout: 20000 },
    );
    await page
      .getByRole('button', { name: 'More workflow actions', exact: true })
      .click();
    const menu = await page.getByRole('menu').elementHandle();
    await refresh;
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await menu.evaluate((node) => node.isConnected)).toBe(true);
    await expect(
      page.getByRole('textbox', { name: 'Reply', exact: true }),
    ).toHaveValue('An unfinished reply survives refreshes.');
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Resolve discussion', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Reopen discussion', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Reply', exact: true }),
    ).toHaveValue('An unfinished reply survives refreshes.');
    await page
      .getByRole('button', { name: 'Reopen discussion', exact: true })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Reply', exact: true }),
    ).toBeEnabled();
    await teammate
      .getByRole('button', { name: 'Edit comment', exact: true })
      .click();
    await teammate
      .getByRole('textbox', { name: 'Edit comment', exact: true })
      .fill('Reader edited their own reply.');
    await teammate
      .getByRole('button', { name: 'Save comment', exact: true })
      .click();
    await expect(
      teammate.getByText('Reader edited their own reply.', { exact: true }),
    ).toBeVisible();
    await teammate
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Temporary reply to remove');
    await teammate
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    const temporary = teammate
      .getByRole('listitem')
      .filter({ hasText: 'Temporary reply to remove' });
    await temporary
      .getByRole('button', { name: 'Delete comment', exact: true })
      .click();
    await teammate
      .getByRole('dialog', { name: 'Delete this comment?', exact: true })
      .getByRole('button', { name: 'Delete comment', exact: true })
      .click();
    await expect(
      teammate.getByText('Temporary reply to remove', { exact: true }),
    ).toHaveCount(0);
    await expect(
      teammate.getByText('Reader edited their own reply.', { exact: true }),
    ).toBeVisible();
    for (const width of [1280, 375]) {
      await teammate.setViewportSize({ width, height: 800 });
      await teammate.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await expect
        .poll(() =>
          teammate.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      await mkdir('/tmp/pertexo-collaboration-screenshots', {
        recursive: true,
      });
      await teammate.getByRole('button', { name: /^Here with you: /u }).click();
      await expect(
        teammate.getByRole('dialog', { name: 'Here with you', exact: true }),
      ).toBeVisible();
      await teammate.keyboard.press('Escape');
      await teammate.screenshot({
        path: `/tmp/pertexo-collaboration-screenshots/discussion-${String(width)}.png`,
        fullPage: true,
      });
    }
    // Grant ordinary builder access through the existing audited member path.
    const role = await page.request.post(
      `/v1/workspaces/${workspaceId}/members/${viewerId}/role`,
      {
        headers: {
          'x-csrf-token': await readCsrfToken(page),
          'Idempotency-Key': randomUUID(),
        },
        data: { role: 'builder', expectedRoleRevision: 1 },
      },
    );
    expect(role.status(), await role.text()).toBe(200);
    await signInEditorUser(teammate, viewerEmail, `/w/${workspaceId}`);
    await page.goto(editor);
    await teammate.goto(editor);
    await teammate.setViewportSize({ width: 1280, height: 800 });
    for (const current of [page, teammate]) {
      await current.getByTestId('rf__node-' + nodeId).focus();
      await current.keyboard.press('Enter');
    }
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route('**/draft', async (route) => {
      if (route.request().method() === 'PUT') {
        held = true;
        await barrier;
      }
      await route.continue();
    });
    try {
      await page
        .getByLabel('Label', { exact: true })
        .fill('Owner unfinished edit');
      await expect.poll(() => held).toBe(true);
      await expect(
        teammate.getByText('Unsaved changes in another tab.', { exact: true }),
      ).toBeVisible({ timeout: 25000 });
      await teammate.screenshot({
        path: '/tmp/pertexo-collaboration-screenshots/presence-1280.png',
        fullPage: true,
      });
      await teammate.setViewportSize({ width: 375, height: 800 });
      expect(
        (await teammate.locator('header').boundingBox())?.height,
      ).toBeLessThanOrEqual(190);
      await expect
        .poll(() =>
          teammate.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      await teammate.screenshot({
        path: '/tmp/pertexo-collaboration-screenshots/presence-375.png',
        fullPage: true,
      });
      await teammate.setViewportSize({ width: 1280, height: 800 });
      await teammate
        .getByLabel('Label', { exact: true })
        .fill('Teammate saved first');
      await expect
        .poll(
          async () =>
            (await readEditorDraft(teammate, path)).graph.nodes[0]?.label,
        )
        .toBe('Teammate saved first');
      release();
      await expect(
        page.getByRole('region', { name: 'Draft conflict' }),
      ).toBeVisible();
      await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
        'Owner unfinished edit',
      );
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await context.close();
  } catch (error) {
    if (primaryError !== undefined)
      throw new AggregateError(
        [primaryError, error],
        'Discussion journey and context disposal failed',
      );
    throw error;
  }
  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined) throw new Error('Discussion journey failed');
});
