import {
  accessibleWorkspacesResponseSchema,
  apiProblemSchema,
  userProfileResponseSchema,
  workflowDraftResponseSchema,
  workflowRunListResponseSchema,
  workflowSummaryResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts';
import { readCsrfToken } from '../../test/support/browser/csrf';

import { expect } from '@playwright/test';

import { randomUUID } from 'node:crypto';

import { mapBrowserInput } from '../../test/support/browser/inputs';

import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

import { test } from '../support/browser-fixture';

import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';

import { inspectViewerViewport } from './readonly/fixture';

test('ordinary verified viewer can inspect the real editor at four widths but cannot change the workflow', async ({
  browser,
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  const ownerEmail = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Readonly qualification owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Readonly qualification',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Viewer inspection',
  );
  const workflowId = workflowPath.split('/')[5];
  if (workflowId === undefined) throw new Error('Workflow ID missing');
  const nodeId = await addSingleStep(
    page,
    workflowPath,
    /Set fields/u,
    'Viewer source',
  );
  await mapBrowserInput({
    page,
    field: 'proof',
    path: '$.proof',
    source: 'Run input',
  });
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({ proof: { kind: 'run_input', path: '$.proof' } });
  const version = await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, { proof: 'readonly-baseline' });
  await waitForRun(page, workspaceId, runId, 'succeeded');
  const ownerDraftResponse = await page.request.get(`${workflowPath}/draft`);
  expect(ownerDraftResponse.status()).toBe(200);
  const ownerDraft = workflowDraftResponseSchema.parse(
    await ownerDraftResponse.json(),
  );
  const etag = ownerDraftResponse.headers().etag;
  expect(etag).toMatch(/^"[^"\r\n]+"$/u);
  const ownerVersionsResponse = await page.request.get(
    `${workflowPath}/versions`,
  );
  expect(ownerVersionsResponse.status()).toBe(200);
  const ownerVersions = workflowVersionsResponseSchema.parse(
    await ownerVersionsResponse.json(),
  );

  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const viewer = await context.newPage();
    const viewerEmail = await registerEditorUser(
      viewer,
      request,
      mailOrigin,
      'Readonly qualification viewer',
    );
    const setup = await request.post(`${mailOrigin}/readonly-setup`, {
      data: { workspaceId, workflowId, ownerEmail, viewerEmail },
    });
    expect(setup.status()).toBe(200);
    const identityResponse = await viewer.request.get('/v1/users/me');
    expect(identityResponse.status()).toBe(200);
    const identity = userProfileResponseSchema.parse(
      await identityResponse.json(),
    );
    expect(identity.email).toBe(viewerEmail);
    expect(await setup.json()).toEqual({
      workspaceId,
      workflowId,
      viewerId: identity.id,
    });
    const discoveryResponse = await viewer.request.get('/v1/workspaces');
    expect(discoveryResponse.status()).toBe(200);
    const accessible = accessibleWorkspacesResponseSchema
      .parse(await discoveryResponse.json())
      .items.find((item) => item.id === workspaceId);
    expect(accessible?.role).toBe('viewer');
    expect(accessible?.capabilities).toContain('workflow:read');
    for (const capability of [
      'workflow:update',
      'workflow:publish',
      'run:start',
      'run:replay',
      'run:cancel',
      'workspace:manage',
    ])
      expect(accessible?.capabilities).not.toContain(capability);
    const summaryResponse = await viewer.request.get(workflowPath);
    expect(summaryResponse.status()).toBe(200);
    expect(
      workflowSummaryResponseSchema.parse(await summaryResponse.json()).workflow
        .publishedVersionId,
    ).toBe(version.id);
    const viewerDraftResponse = await viewer.request.get(
      `${workflowPath}/draft`,
    );
    expect(viewerDraftResponse.status()).toBe(200);
    expect(viewerDraftResponse.headers().etag).toBe(etag);
    expect(
      workflowDraftResponseSchema.parse(await viewerDraftResponse.json()),
    ).toEqual(ownerDraft);
    const versionsResponse = await viewer.request.get(
      `${workflowPath}/versions`,
    );
    expect(versionsResponse.status()).toBe(200);
    expect(
      workflowVersionsResponseSchema.parse(await versionsResponse.json()),
    ).toEqual(ownerVersions);
    const runsResponse = await viewer.request.get(
      `/v1/workspaces/${workspaceId}/runs?workflowId=${workflowId}`,
    );
    expect(runsResponse.status()).toBe(200);
    expect(
      workflowRunListResponseSchema
        .parse(await runsResponse.json())
        .items.map((run) => run.id),
    ).toEqual([runId]);

    // Presence heartbeats are allowed; definition and execution writes are not.
    const uiWrites: string[] = [];
    const presenceWrites: string[] = [];
    viewer.on('request', (outgoing) => {
      const pathname = new URL(outgoing.url()).pathname;
      if (
        outgoing.method() === 'PUT' &&
        pathname.startsWith(`${workflowPath}/presence/`)
      ) {
        presenceWrites.push(pathname);
        return;
      }
      if (
        new URL(outgoing.url()).pathname.startsWith(workflowPath) &&
        !['GET', 'HEAD'].includes(outgoing.method())
      )
        uiWrites.push(
          `${outgoing.method()} ${new URL(outgoing.url()).pathname}`,
        );
    });
    await viewer.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [390, 1024, 1280, 1440]) {
      await inspectViewerViewport(viewer, {
        width,
        workspaceId,
        workflowId,
        nodeId,
      });
    }

    expect(uiWrites).toEqual([]);
    expect(presenceWrites.length).toBeGreaterThan(0);

    const csrf = await readCsrfToken(viewer, {
      missingMessage: 'Ordinary session CSRF/ETag missing',
    });
    if (etag === undefined)
      throw new Error('Ordinary session CSRF/ETag missing');
    const headers = {
      'x-csrf-token': csrf,
      'Idempotency-Key': randomUUID(),
      'If-Match': etag,
    };
    for (const [method, path, data] of [
      ['PUT', `${workflowPath}/draft`, { graph: ownerDraft.graph }],
      ['POST', `${workflowPath}/publish`, {}],
      [
        'POST',
        `${workflowPath}/runs`,
        { input: { proof: 'must-not-execute' } },
      ],
    ] as const) {
      const denied = await viewer.request.fetch(path, {
        method,
        headers,
        data,
      });
      expect(denied.status()).toBe(404);
      expect(apiProblemSchema.parse(await denied.json()).code).toBe(
        'resource.not_found',
      );
    }
    const ownerAfter = await page.request.get(`${workflowPath}/draft`);
    expect(ownerAfter.status()).toBe(200);
    expect(ownerAfter.headers().etag).toBe(etag);
    expect(workflowDraftResponseSchema.parse(await ownerAfter.json())).toEqual(
      ownerDraft,
    );
    await viewer.goto(`/w/${workspaceId}/workflows`);
    await expect(viewer).toHaveURL(`/w/${workspaceId}/workflows`);
    await expect(
      viewer.getByRole('button', { name: 'New workflow', exact: true }),
    ).toHaveCount(0);
    expect(uiWrites).toEqual([]);
    const submitted = await request.post(`${mailOrigin}/evidence/readonly`, {
      data: { workspaceId, workflowId, viewerId: identity.id },
    });
    expect(submitted.status()).toBe(204);
  } finally {
    await context.close();
  }
});
