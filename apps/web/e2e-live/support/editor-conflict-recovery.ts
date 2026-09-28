import { expect, type Browser, type Page, type Route } from '@playwright/test';
import {
  strongEtagSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowRevisionConflictProblemSchema,
  workflowVersionsResponseSchema,
  type WorkflowVersionResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  workflowNodeRunOutputResponseSchema,
  workflowRunResponseSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { signInEditorUser } from './ordinary-editor-session';

/** Holds dispatch, not the response: the server itself must reject the stale ETag. */
export async function verifyEditorConflictAndImmutableRun(
  browser: Browser,
  page: Page,
  input: Readonly<{
    email: string;
    workspaceId: string;
    workflowId: string;
    rootId: string;
    runId: string;
    version: WorkflowVersionResponse;
  }>,
) {
  const workflowPath = `/v1/workspaces/${input.workspaceId}/workflows/${input.workflowId}`;
  const draftPath = `${workflowPath}/draft`;
  const editorUrl = `/w/${input.workspaceId}/workflows/${input.workflowId}`;
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  let releaseDispatch: () => void = () => {
    throw new Error('Dispatch gate not initialized');
  };
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let held: Route | undefined;
  const submittedEtags: string[] = [];
  const holdFirstSave = async (route: Route) => {
    if (route.request().method() === 'PUT') {
      submittedEtags.push(
        strongEtagSchema.parse(route.request().headers()['if-match']),
      );
      if (held === undefined) {
        held = route;
        await dispatchGate;
      }
    }
    await route.continue();
  };
  async function saved() {
    const response = await page.request.get(draftPath);
    expect(response.status()).toBe(200);
    return {
      body: workflowDraftResponseSchema.parse(await response.json()),
      etag: strongEtagSchema.parse(response.headers().etag),
    };
  }
  async function nameRoot(target: Page, label: string) {
    await target.getByTestId(`rf__node-${input.rootId}`).focus();
    await target.keyboard.press('Enter');
    await target.getByLabel('Label', { exact: true }).fill(label);
    await target.keyboard.press('Tab');
  }
  try {
    const second = await context.newPage();
    await signInEditorUser(second, input.email, `/w/${input.workspaceId}`);
    await second.goto(editorUrl);
    await page.goto(editorUrl);
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await expect(second.locator('.react-flow__node')).toHaveCount(4);
    const baseline = await saved();
    await page.route(draftPath, holdFirstSave);
    await nameRoot(page, 'Local source choice');
    await expect.poll(() => held !== undefined).toBe(true);
    if (held === undefined)
      throw new Error('Original browser save was not intercepted');
    expect(submittedEtags).toEqual([baseline.etag]);
    const original = workflowDraftSaveRequestSchema.parse(
      held.request().postDataJSON(),
    );
    expect(
      original.graph.nodes.find((node) => node.id === input.rootId)?.label,
    ).toBe('Local source choice');
    await nameRoot(second, 'Remote source choice');
    await expect
      .poll(
        async () =>
          (await saved()).body.graph.nodes.find(
            (node) => node.id === input.rootId,
          )?.label,
      )
      .toBe('Remote source choice');
    const remote = await saved();
    expect(remote.etag).not.toBe(baseline.etag);
    expect(remote.body.revision).toBeGreaterThan(baseline.body.revision);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === draftPath,
    );
    releaseDispatch();
    const rejection = await responsePromise;
    expect(rejection.status()).toBe(412);
    expect(
      workflowRevisionConflictProblemSchema.parse(await rejection.json()),
    ).toMatchObject({
      currentRevision: remote.body.revision,
      currentEtag: remote.etag,
    });
    const conflict = page.getByRole('region', { name: 'Draft conflict' });
    await expect(conflict).toContainText('Changed elsewhere');
    await conflict
      .getByRole('button', { name: 'Compare', exact: true })
      .click();
    const compare = page.getByRole('dialog', {
      name: 'Your copy and theirs',
      exact: true,
    });
    await compare.getByRole('tab', { name: 'JSON', exact: true }).click();
    await expect(
      compare.locator('figure').filter({ hasText: 'Your copy' }),
    ).toContainText('Local source choice');
    await expect(
      compare.locator('figure').filter({ hasText: 'Their version' }),
    ).toContainText('Remote source choice');
    await compare.getByRole('button', { name: 'Close', exact: true }).click();
    await conflict
      .getByRole('button', { name: 'Keep mine', exact: true })
      .click();
    await expect(conflict).toContainText('Your copy is kept for comparison');
    expect((await saved()).body.graph).toEqual(remote.body.graph);
    expect(submittedEtags).toEqual([baseline.etag]);
    await page.getByTestId(`rf__node-${input.rootId}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
      'Remote source choice',
    );
    await conflict
      .getByRole('button', { name: 'Compare', exact: true })
      .click();
    await compare.getByRole('tab', { name: 'Steps', exact: true }).click();
    await compare
      .getByRole('button', {
        name: 'Use your copy of Local source choice',
        exact: true,
      })
      .click();
    await compare.getByRole('button', { name: 'Close', exact: true }).click();
    const reappliedGraph = {
      ...remote.body.graph,
      nodes: remote.body.graph.nodes.map((node) =>
        node.id === input.rootId
          ? { ...node, label: 'Local source choice' }
          : node,
      ),
    };
    await expect
      .poll(async () => (await saved()).body.graph)
      .toEqual(reappliedGraph);
    expect(submittedEtags.slice(0, 2)).toEqual([baseline.etag, remote.etag]);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    const literalRow = page
      .getByRole('region', { name: 'Inputs', exact: true })
      .locator('ol > li')
      .filter({
        has: page.getByRole('button', { name: /^literalProof from/u }),
      });
    await literalRow
      .getByRole('button', { name: /^literalProof from/u })
      .click();
    await literalRow
      .getByLabel('JSON value', { exact: true })
      .fill('"unpublished-after-run"');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () =>
          (await saved()).body.graph.nodes.find(
            (node) => node.id === input.rootId,
          )?.inputMappings.literalProof,
      )
      .toEqual({ kind: 'literal', value: 'unpublished-after-run' });
    const finalDraft = await saved();
    expect(finalDraft.body.revision).toBeGreaterThan(remote.body.revision);
    const versionsResponse = await page.request.get(`${workflowPath}/versions`);
    expect(versionsResponse.status()).toBe(200);
    const versions = workflowVersionsResponseSchema.parse(
      await versionsResponse.json(),
    );
    expect(versions.items).toEqual([input.version]);
    const runResponse = await page.request.get(
      `/v1/workspaces/${input.workspaceId}/runs/${input.runId}`,
    );
    expect(runResponse.status()).toBe(200);
    const run = workflowRunResponseSchema.parse(await runResponse.json());
    expect(run.run.workflowVersionId).toBe(input.version.id);
    const root = run.nodes.find((node) => node.nodeId === input.rootId);
    if (root === undefined) throw new Error('Accepted root invocation missing');
    const outputResponse = await page.request.get(
      `/v1/workspaces/${input.workspaceId}/runs/${input.runId}/node-runs/${root.id}/output`,
    );
    expect(outputResponse.status()).toBe(200);
    expect(
      workflowNodeRunOutputResponseSchema.parse(await outputResponse.json())
        .output,
    ).toMatchObject({
      kind: 'inline',
      value: { literalProof: 'from-real-browser' },
    });
    await conflict
      .getByRole('button', { name: 'Dismiss copy', exact: true })
      .click();
    await expect(conflict).toBeHidden();
    return {
      conflictRevision: remote.body.revision,
      finalDraftRevision: finalDraft.body.revision,
    };
  } finally {
    releaseDispatch();
    await page.unroute(draftPath, holdFirstSave);
    await context.close();
  }
}
