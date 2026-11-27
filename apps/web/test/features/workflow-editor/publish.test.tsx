import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addStepButton,
  openStepList,
  openWorkflowMenu,
  findCanvas,
} from '../../support/fixtures/editor-actions';
import {
  graphWithMappingNodes,
  graphWithNumericConfig,
} from '../../support/fixtures/editor-graph';
import {
  compatibility,
  editorHandlers,
  editorPath,
  emptyGraph,
  etagB,
  manualDefinition,
  mappingDefinition,
  numericDefinition,
  runDetailHandlers,
  runId,
  runSummary,
  user,
  validHandler,
  versionBody,
  versionId,
  workflowApi,
  workflowId,
  workflowSummaryHandler,
  workspaceId,
} from '../../support/fixtures/workflow-editor';

import { mockServer } from '../../support/mock-server';

import { renderLoadedApp } from '../../support/render-app';

afterEach(() => vi.useRealTimers());

describe('workflow editor publishing', { timeout: 30_000 }, () => {
  it('keeps a different server snapshot readable and stale without publishing it', async () => {
    let publishes = 0;
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithNumericConfig({ requiredCount: 1 }),
      }),
    );
    mockServer.use(
      validHandler(undefined, etagB),
      http.post(`${workflowApi}/publish`, () => {
        publishes += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    await renderLoadedApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await event.click(screen.getByRole('button', { name: 'Publish v1' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    await event.click(within(lens).getByRole('button', { name: 'Publish v1' }));
    expect(
      await within(lens).findByText(/This check describes a different draft/u),
    ).toBeVisible();
    expect(publishes).toBe(0);
    await event.click(within(lens).getByRole('button', { name: 'Cancel' }));
    const menu = await openWorkflowMenu(event);
    await event.click(menu.getByRole('menuitem', { name: /1 issue/u }));
    expect(
      await screen.findByText(
        /This check describes a different draft; check again/u,
      ),
    ).toBeVisible();
  });
  it('checks and publishes without a manual validate, then weaves in the new version', async () => {
    const publishes: Readonly<{ etag: string | null; key: string | null }>[] =
      [];
    let validations = 0;
    let savedGraph = emptyGraph;
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedGraph = body.graph;
      }),
    );
    mockServer.use(
      validHandler(() => {
        validations += 1;
      }),
      http.get(`${workflowApi}/versions`, () =>
        HttpResponse.json({
          items:
            publishes.length > 0 ? [versionBody(versionId, savedGraph)] : [],
          nextCursor: null,
        }),
      ),
      http.post(`${workflowApi}/publish`, ({ request }) => {
        publishes.push({
          etag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        mockServer.use(workflowSummaryHandler('Test workflow', versionId));
        return HttpResponse.json({
          version: versionBody(versionId, savedGraph),
          reused: false,
        });
      }),
      http.post(`${workflowApi}/runs`, ({ request }) => {
        expect(request.headers.get('idempotency-key')).toBeTruthy();
        return HttpResponse.json({
          run: runSummary(runId, versionId, 'queued'),
          replayed: false,
        });
      }),
      ...runDetailHandlers(),
    );
    const app = await renderLoadedApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await openStepList(event);
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('button', { name: 'Publish v1' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    expect(within(lens).getByText(/Runs already in progress/u)).toBeVisible();
    await event.click(within(lens).getByRole('button', { name: 'Publish v1' }));
    expect(
      await screen.findByText('v1 is live', {}, { timeout: 4_000 }),
    ).toBeVisible();
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.etag).toBe(etagB);
    expect(validations).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Edited since/u)).toBeNull();

    await openStepList(event);
    await event.click(addStepButton(/Set fields/u));
    expect(screen.getByText('Edited since v1')).toBeVisible();
    await event.click(
      screen.getByRole('button', { name: 'Test and run actions' }),
    );
    // Starts at once: no input to confirm for a run with nothing to fill in.
    await event.click(
      await screen.findByRole('menuitem', { name: 'Run published version' }),
    );
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${runId}`,
      );
    });
  });
  it('shows a new version on the Versions tab right after publishing it', async () => {
    let savedGraph = emptyGraph;
    let published = false;
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedGraph = body.graph;
      }),
    );
    mockServer.use(
      validHandler(),
      workflowSummaryHandler('Order intake', null),
      http.get(`${workflowApi}/versions`, () =>
        HttpResponse.json({
          items: published
            ? [{ ...versionBody(versionId, savedGraph), publishedBy: null }]
            : [],
          nextCursor: null,
        }),
      ),
      http.post(`${workflowApi}/publish`, () => {
        published = true;
        return HttpResponse.json({
          version: versionBody(versionId, savedGraph),
          reused: false,
        });
      }),
    );
    // Versions is read first, so its list is cached and fresh when the
    // publish lands a moment later.
    const app = await renderLoadedApp(`${editorPath}/versions`);
    expect(await screen.findByText(/Nothing published yet/u)).toBeVisible();
    await app.router.navigate({
      to: '/w/$workspaceId/workflows/$workflowId',
      params: { workspaceId, workflowId },
    });
    const event = userEvent.setup();
    await findCanvas();
    await openStepList(event);
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('button', { name: 'Publish v1' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    await event.click(within(lens).getByRole('button', { name: 'Publish v1' }));
    expect(
      await screen.findByText('v1 is live', {}, { timeout: 4_000 }),
    ).toBeVisible();

    await app.router.navigate({
      to: '/w/$workspaceId/workflows/$workflowId/versions',
      params: { workspaceId, workflowId },
    });
    const thread = await screen.findByRole('navigation', { name: 'Versions' });
    const publishedVersion = within(thread).getByRole('button', {
      name: /^v1/u,
    });
    expect(publishedVersion).toBeVisible();
    expect(publishedVersion).toHaveTextContent('A former member');
    expect(within(thread).getByRole('link', { name: /^Draft/u })).toBeVisible();
  });
  it('stops publishing when the saved draft has issues and lists them', async () => {
    let publishes = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.post(`${workflowApi}/validate`, () =>
        HttpResponse.json(
          {
            valid: false,
            currentPublication: null,
            issues: [
              {
                path: '$',
                code: 'cycle',
                message: 'cycle contains a',
              },
            ],
            compatibility,
          },
          { headers: { etag: etagB } },
        ),
      ),
      http.post(`${workflowApi}/publish`, () => {
        publishes += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    await renderLoadedApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await openStepList(event);
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('button', { name: 'Publish v1' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    await event.click(within(lens).getByRole('button', { name: 'Publish v1' }));
    expect(await within(lens).findByText('Fix these first')).toBeVisible();
    expect(
      within(lens).getByText(/These steps loop back on themselves/u),
    ).toBeVisible();
    expect(
      within(lens).getByRole('button', { name: 'Publish v1' }),
    ).toBeDisabled();
    expect(publishes).toBe(0);
    await event.click(within(lens).getByRole('button', { name: 'Cancel' }));
    const menu = await openWorkflowMenu(event);
    expect(
      await menu.findByRole('menuitem', { name: '2 issues' }),
    ).toBeVisible();
  });
  it('summarises the changes against the live version and names the next version', async () => {
    const liveGraph = {
      ...emptyGraph,
      nodes: graphWithMappingNodes().nodes.slice(0, 1),
    };
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    mockServer.use(
      http.get(workflowApi, () =>
        HttpResponse.json({
          workflow: {
            id: workflowId,
            workspaceId,
            name: 'Invoice intake',
            nameRevision: 1,
            lifecycleStatus: 'active',
            lifecycleRevision: 1,
            activationStatus: 'active',
            webhookSetupRequired: false,
            publishedVersionId: versionId,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        }),
      ),
      http.get(`${workflowApi}/versions`, () =>
        HttpResponse.json({
          items: [versionBody(versionId, liveGraph, 7)],
          nextCursor: null,
        }),
      ),
    );
    await renderLoadedApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    expect(
      await screen.findByRole('heading', { name: 'Invoice intake' }),
    ).toBeVisible();
    // The state line names the version that runs: "Live v7".
    expect(await screen.findByText('v7')).toBeVisible();
    await event.click(
      await screen.findByRole('button', { name: 'Publish v8' }),
    );
    const lens = await screen.findByRole('dialog', { name: 'Publish v8' });
    expect(within(lens).getByText('Changes since v7')).toBeVisible();
    expect(within(lens).getByText('Target')).toBeVisible();
    expect(within(lens).getByText('Added:')).toBeInTheDocument();
    expect(within(lens).getByText('Links between steps')).toBeVisible();
    expect(within(lens).getByText('1 added, 0 removed')).toBeVisible();
  });
  it('keeps Publish usable while a save that lands with the dialog open is checked again', async () => {
    let saves = 0;
    let policyReads = 0;
    let answerPolicy: (() => void) | undefined;
    mockServer.use(
      ...editorHandlers(() => {
        saves += 1;
      }),
    );
    mockServer.use(
      validHandler(),
      http.get(`${workflowApi}/publication-review`, async () => {
        policyReads += 1;
        // The policy for the newly saved draft is still on its way.
        if (policyReads > 1)
          await new Promise<void>((resolve) => {
            answerPolicy = resolve;
          });
        return HttpResponse.json({ required: false, request: null });
      }),
    );
    await renderLoadedApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await openStepList(event);
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('button', { name: 'Publish v1' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    await waitFor(
      () => {
        expect(saves).toBe(1);
        expect(policyReads).toBe(2);
      },
      { timeout: 4_000 },
    );
    expect(
      within(lens).getByRole('button', { name: 'Publish v1' }),
    ).toBeEnabled();
    answerPolicy?.();
  });
  it('refuses to publish while a step has an unfinished edit, without asking the server', async () => {
    let publishes = 0;
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithNumericConfig({ count: 4, requiredCount: 1 }),
        definitions: [numericDefinition],
      }),
    );
    mockServer.use(
      validHandler(),
      http.post(`${workflowApi}/publish`, () => {
        publishes += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    await renderLoadedApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Numbers'));
    const count = await screen.findByLabelText('Count');
    fireEvent.change(count, { target: { value: '-' } });
    fireEvent.blur(count);
    expect(screen.getByText('Count must be a number.')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Publish v1' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    await event.click(within(lens).getByRole('button', { name: 'Publish v1' }));
    expect(
      await screen.findByText(
        'Finish or discard the unfinished edit in the step panel first.',
      ),
    ).toBeVisible();
    expect(publishes).toBe(0);
  });
});
