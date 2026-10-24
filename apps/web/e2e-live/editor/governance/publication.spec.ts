import { readCsrfToken } from '../../../test/support/browser/csrf';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { publicationReviewDetailSchema } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  signInEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import { createEditorWorkflow } from '../../support/authoring/single-step';

const step = (id: string, key: string, x: number) => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x, y: 0 },
});
test('a builder requests an exact draft on a phone, an owner reviews it, and an edit makes the next request stale', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  const ownerEmail = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Publishing owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Publishing qualification',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Reviewed release',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const editorUrl = `/w/${workspaceId}/workflows/${workflowId}`;
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  let primaryError: unknown;
  try {
    const builder = await context.newPage();
    builder.setDefaultTimeout(15000);
    const viewerEmail = await registerEditorUser(
      builder,
      request,
      mailOrigin,
      'Release builder',
    );
    const setup = await request.post(`${mailOrigin}/readonly-setup`, {
      data: { workspaceId, workflowId, ownerEmail, viewerEmail },
    });
    expect(setup.status()).toBe(200);
    const { viewerId } = (await setup.json()) as { viewerId: string };
    await page.goto(`/w/${workspaceId}/settings/audit`);
    await page
      .getByRole('checkbox', { name: 'Require approval to publish' })
      .check();
    await page
      .getByRole('button', { name: 'Save publishing policy', exact: true })
      .click();
    await expect(
      page.getByText(
        'Add another active owner or admin before requiring approval to publish.',
        { exact: true },
      ),
    ).toBeVisible();
    const refused = await page.request.get(
      `/v1/workspaces/${workspaceId}/governance/settings`,
    );
    expect(refused.status()).toBe(200);
    expect(await refused.json()).toMatchObject({
      revision: 1,
      requirePublishApproval: false,
    });
    const role = await page.request.post(
      `/v1/workspaces/${workspaceId}/members/${viewerId}/role`,
      {
        headers: {
          'x-csrf-token': await readCsrfToken(page),
          'Idempotency-Key': randomUUID(),
        },
        data: { role: 'admin', expectedRoleRevision: 1 },
      },
    );
    expect(role.status(), await role.text()).toBe(200);
    const draft = await page.request.get(`${workflowPath}/draft`);
    const graph = {
      settings: {},
      nodes: [
        step('manual', 'core.manual', 0),
        {
          ...step('done', 'core.terminate', 260),
          config: {},
        },
      ],
      edges: [
        {
          id: 'entry',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'done', port: 'in' },
        },
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
    await page.goto(`/w/${workspaceId}/settings/audit`);
    await page
      .getByRole('checkbox', { name: 'Require approval to publish' })
      .check();
    await page
      .getByRole('button', { name: 'Save publishing policy', exact: true })
      .click();
    await expect(
      page.getByText('Publishing policy saved.', { exact: true }),
    ).toBeVisible();
    // Enabling needs another reviewer; later role loss leaves the explicit policy intact.
    const builderRole = await page.request.post(
      `/v1/workspaces/${workspaceId}/members/${viewerId}/role`,
      {
        headers: {
          'x-csrf-token': await readCsrfToken(page),
          'Idempotency-Key': randomUUID(),
        },
        data: { role: 'builder', expectedRoleRevision: 2 },
      },
    );
    expect(builderRole.status(), await builderRole.text()).toBe(200);
    await signInEditorUser(builder, viewerEmail, `/w/${workspaceId}`);
    await builder.setViewportSize({ width: 375, height: 800 });
    await builder.goto(editorUrl);
    const policy = await builder.request.get(
      `${workflowPath}/publication-review`,
    );
    expect(policy.status(), await policy.text()).toBe(200);
    expect(await policy.json()).toMatchObject({ required: true });
    await mkdir('/tmp/pertexo-publication-review-screenshots', {
      recursive: true,
    });
    await builder.screenshot({
      path: '/tmp/pertexo-publication-review-screenshots/editor-375.png',
      fullPage: true,
    });
    await builder
      .getByRole('button', { name: 'Request review', exact: true })
      .click();
    const dialog = builder.getByRole('dialog', {
      name: 'Request publication review',
      exact: true,
    });
    await dialog
      .getByLabel('Note for the reviewer')
      .fill('Release the reviewed workflow.');
    const submit = dialog.getByRole('button', {
      name: 'Request review',
      exact: true,
    });
    await expect(submit).toBeEnabled();
    await test.step('Submit the reviewed draft', () => submit.click(), {
      timeout: 15000,
    });
    await expect(builder).toHaveURL(/\/publish-reviews\/[^/]+$/u);
    const reviewUrl = new URL(builder.url()).pathname;
    await expect(
      builder.getByText(
        'Another owner or admin must decide your publication request.',
        { exact: true },
      ),
    ).toBeVisible();
    await mkdir('/tmp/pertexo-publication-review-screenshots', {
      recursive: true,
    });
    await builder.screenshot({
      path: '/tmp/pertexo-publication-review-screenshots/request-375.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(reviewUrl);
    await expect(
      page.getByRole('region', { name: 'Reviewed draft' }),
    ).toContainText('Exactly what will be published');
    await page
      .getByLabel('Review comment (optional)')
      .fill('Reviewed the exact revision.');
    await page.screenshot({
      path: '/tmp/pertexo-publication-review-screenshots/review-1280.png',
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Approve and publish', exact: true })
      .click();
    await expect(
      page.getByText('Published v1. This decision is complete.', {
        exact: true,
      }),
    ).toBeVisible();
    const reviewId = reviewUrl.split('/').at(-1);
    const result = await page.request.get(
      `/v1/workspaces/${workspaceId}/publication-requests/${String(reviewId)}`,
    );
    const approved = publicationReviewDetailSchema.parse(await result.json());
    expect(approved.request).toMatchObject({
      status: 'approved',
      draftRevision: 2,
      versionNumber: 1,
    });
    const nextDraft = await builder.request.get(`${workflowPath}/draft`);
    const changed = await builder.request.put(`${workflowPath}/draft`, {
      headers: {
        'If-Match': nextDraft.headers().etag ?? '',
        'x-csrf-token': await readCsrfToken(builder),
      },
      data: { graph: { ...graph, settings: { maxRunDurationMs: 60000 } } },
    });
    expect(changed.status()).toBe(200);
    await builder.goto(editorUrl);
    await builder
      .getByRole('button', { name: 'Request review', exact: true })
      .click();
    await builder
      .getByLabel('Note for the reviewer')
      .fill('Review the new duration.');
    await builder
      .getByRole('dialog')
      .getByRole('button', { name: 'Request review', exact: true })
      .click();
    await expect(builder).toHaveURL(/\/publish-reviews\/[^/]+$/u);
    const staleUrl = new URL(builder.url()).pathname;
    const changing = await builder.request.get(`${workflowPath}/draft`);
    const edited = await builder.request.put(`${workflowPath}/draft`, {
      headers: {
        'If-Match': changing.headers().etag ?? '',
        'x-csrf-token': await readCsrfToken(builder),
      },
      data: { graph: { ...graph, settings: { maxRunDurationMs: 90000 } } },
    });
    expect(edited.status()).toBe(200);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(staleUrl);
    await expect(
      page.getByText(
        'This request is stale or expired. Review the latest draft and request approval again.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve and publish' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Reviewed draft' }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: '/tmp/pertexo-publication-review-screenshots/stale-375.png',
      fullPage: true,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    await context.close();
  } catch (error) {
    if (primaryError !== undefined)
      throw new AggregateError(
        [primaryError, error],
        'Review journey and context disposal failed',
      );
    throw error;
  }
  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined)
    throw new Error('Publication review journey failed');
});
