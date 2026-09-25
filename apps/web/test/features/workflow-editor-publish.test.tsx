import { HttpResponse, http } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  addStepButton,
  checkNow,
  compatibility,
  editorHandlers,
  editorPath,
  emptyGraph,
  etagB,
  findCanvas,
  graphWithMappingNodes,
  graphWithNumericConfig,
  manualDefinition,
  mappingDefinition,
  numericDefinition,
  openRunLens,
  runDetailHandlers,
  runId,
  runSummary,
  setDefinition,
  user,
  validHandler,
  versionBody,
  versionId,
  workflowApi,
  workflowId,
  workflowSummaryHandler,
  workspaceId,
} from '../support/workflow-editor-fixtures';

// The lazy editor route and React Flow are slow to start on a busy machine.

describe('workflow editor publishing', { timeout: 30_000 }, () => {
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
      http.post(`${workflowApi}/publish`, ({ request }) => {
        publishes.push({
          etag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
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
    const app = renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    expect(within(lens).getByText(/Runs already in progress/u)).toBeVisible();
    await event.click(
      within(lens).getByRole('button', { name: 'Publish this draft' }),
    );
    expect(
      await screen.findByText('v1 is live', {}, { timeout: 4_000 }),
    ).toBeVisible();
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.etag).toBe(etagB);
    expect(validations).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('v1 live')).toBeVisible();

    await event.click(addStepButton(/Set fields/u));
    expect(screen.getByText('v1 live · edited since')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Run' }));
    await event.click(
      await screen.findByRole('menuitem', { name: 'Run published version' }),
    );
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${runId}`,
      );
    });
  });

  it('stops publishing when the saved draft has issues and lists them', async () => {
    let publishes = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.post(`${workflowApi}/validate`, () =>
        HttpResponse.json({
          valid: false,
          issues: [
            {
              path: '$',
              code: 'cycle',
              message: 'cycle contains a',
            },
          ],
          compatibility,
        }),
      ),
      http.post(`${workflowApi}/publish`, () => {
        publishes += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    const lens = await screen.findByRole('dialog', { name: /Publish/u });
    await event.click(
      within(lens).getByRole('button', { name: 'Publish this draft' }),
    );
    expect(await within(lens).findByText('Fix these first')).toBeVisible();
    expect(
      within(lens).getByText(/These steps loop back on themselves/u),
    ).toBeVisible();
    expect(
      within(lens).getByRole('button', { name: 'Publish this draft' }),
    ).toBeDisabled();
    expect(publishes).toBe(0);
    await event.click(within(lens).getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('button', { name: '1 issue' }),
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
            lifecycleStatus: 'active',
            lifecycleRevision: 1,
            activationStatus: 'active',
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
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    expect(
      await screen.findByRole('heading', { name: 'Invoice intake' }),
    ).toBeVisible();
    await event.click(
      await screen.findByRole('button', { name: 'Publish v8' }),
    );
    const lens = await screen.findByRole('dialog', { name: 'Publish v8' });
    expect(within(lens).getByText('Changes since v7')).toBeVisible();
    expect(within(lens).getByText('Target')).toBeVisible();
    expect(within(lens).getByText('Added:')).toBeInTheDocument();
    expect(within(lens).getByText('1 connection added.')).toBeVisible();
  });

  it('disables Run until something is published and Publish until the draft has a step', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        definitions: [manualDefinition, setDefinition],
      }),
    );
    mockServer.use(validHandler(), workflowSummaryHandler('Draft only', null));
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await screen.findByRole('heading', { name: 'Draft only' });
    expect(
      await screen.findByRole('button', { name: 'Run (publish first)' }),
    ).toHaveAttribute('aria-disabled', 'true');
    const publish = screen.getByRole('button', { name: 'Publish v1' });
    expect(publish).toHaveAttribute('aria-disabled', 'true');
    expect(publish).toHaveAccessibleDescription('Add a trigger to start');
    expect(
      await screen.findByRole('button', { name: 'Add a trigger to start' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'No issues' })).toBeNull();

    await event.click(
      within(screen.getByRole('list', { name: 'Triggers' })).getByRole(
        'button',
        { name: /Manual start/u },
      ),
    );
    expect(screen.getByRole('button', { name: 'Publish v1' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Add a trigger to start' }),
    ).toBeNull();
  });
});

describe('workflow editor issues and checks', { timeout: 30_000 }, () => {
  it('groups issues by step and Fix opens the right field', async () => {
    const nodeId = '11111111-1111-4111-8111-111111111111';
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithNumericConfig({ requiredCount: 1 }),
        definitions: [numericDefinition],
      }),
    );
    mockServer.use(
      http.post(`${workflowApi}/validate`, () =>
        HttpResponse.json({
          valid: false,
          issues: [
            {
              path: `$.nodes.${nodeId}.config.count`,
              code: 'invalid_config',
              message: 'count is required for this node',
            },
            {
              path: '$',
              code: 'invalid_graph',
              message: 'The workflow also has a general issue.',
            },
          ],
          compatibility,
        }),
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await checkNow(event);
    expect(
      await screen.findByText('Count is required for this node.'),
    ).toBeVisible();
    expect(
      screen.getByText('The workflow also has a general issue.'),
    ).toBeVisible();
    expect(screen.getByText('Whole workflow')).toBeVisible();
    await event.click(
      screen.getByRole('button', {
        name: 'Fix: Count is required for this node.',
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Count')).toHaveFocus();
    });
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: '2 issues' })).toBeVisible();
  });

  it('navigates compatibility and mapping findings to their step', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: {
          ...graphWithMappingNodes({
            customer: {
              kind: 'node_output',
              nodeId: 'manual',
              path: '$.customer',
            },
          }),
          nodes: [
            ...graphWithMappingNodes({
              customer: {
                kind: 'node_output',
                nodeId: 'manual',
                path: '$.customer',
              },
            }).nodes,
            {
              id: 'node-unsupported',
              definition: { key: 'core.retired', version: 7 },
              position: { x: 80, y: 280 },
              configVersion: 1,
              config: { unknown: { preserved: true } },
              inputMappings: {},
              connectionRefs: {},
            },
          ],
        },
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    mockServer.use(
      http.post(`${workflowApi}/validate`, () =>
        HttpResponse.json({
          valid: false,
          issues: [
            {
              path: '$.nodes.target.inputMappings.customer',
              code: 'invalid_mapping',
              message:
                'node output mappings must reference a direct local predecessor',
            },
          ],
          compatibility: {
            compatible: false,
            fingerprint: compatibility.fingerprint,
            issues: [
              {
                code: 'unknown_definition',
                definitionKey: 'core.retired',
                version: 7,
              },
            ],
          },
        }),
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await checkNow(event);
    await event.click(
      await screen.findByRole('button', {
        name: /Fix: This step’s type isn’t in the catalog/u,
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveFocus();
    });
    expect(screen.getByLabelText('Setup as JSON')).toBeVisible();

    await event.click(screen.getByRole('button', { name: '2 issues' }));
    await event.click(
      await screen.findByRole('button', {
        name: /Fix: An input reads from a step/u,
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Field')).toHaveFocus();
    });
    expect(screen.getByLabelText('Field')).toHaveValue('customer');
  });

  it('checks the saved draft automatically once editing pauses', async () => {
    let validations = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      validHandler(() => {
        validations += 1;
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await waitFor(
      () => {
        expect(validations).toBe(1);
      },
      { timeout: 6_000 },
    );
    expect(
      await screen.findByRole('button', { name: 'No issues' }),
    ).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 1_800));
    expect(validations).toBe(1);
  });

  it('associates run-start validation with the input and focuses it', async () => {
    mockServer.use(...editorHandlers(() => undefined));
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await openRunLens(event);
    const input = screen.getByLabelText('Run input (JSON)');
    fireEvent.change(input, { target: { value: '{' } });
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/isn’t valid JSON/u);
    fireEvent.change(input, { target: { value: '{}' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });
});
