import { HttpResponse, http } from 'msw';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const etagA = `"draft-v1.${'a'.repeat(43)}"`;
const etagB = `"draft-v1.${'b'.repeat(43)}"`;
const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};
const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
  issues: [],
};
const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: [
    'workspace:read',
    'workflow:read',
    'workflow:update',
    'workflow:publish',
    'run:read',
    'run:start',
    'run:cancel',
    'connection:read',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const emptyGraph: WorkflowGraphContract = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
};
const definition = {
  schemaVersion: 1,
  definition: { key: 'core.set', version: 1 },
  family: 'transform',
  configVersion: 1,
  configSchema: {
    type: 'object',
    properties: { value: { type: 'string', title: 'Value' } },
  },
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
} satisfies NodeDefinitionCatalogItem;
const manualDefinition = {
  ...definition,
  definition: { key: 'core.manual', version: 1 },
  family: 'trigger',
  inputSchema: {},
  outputSchema: { type: 'object', additionalProperties: true },
  ports: { inputs: [], outputs: ['out'] },
} satisfies NodeDefinitionCatalogItem;
const mappingDefinition = {
  ...definition,
  inputSchema: {
    type: 'object',
    properties: {
      customer: { type: 'string', title: 'Customer' },
      requestedBy: { type: 'string', title: 'Requested by' },
      active: { type: 'boolean', title: 'Active' },
    },
    additionalProperties: true,
  },
  outputSchema: { type: 'object', additionalProperties: true },
} satisfies NodeDefinitionCatalogItem;
const numericDefinition = {
  ...definition,
  configSchema: {
    type: 'object',
    required: ['requiredCount'],
    properties: {
      value: { type: 'string', title: 'Value' },
      count: { type: 'number', title: 'Count' },
      requiredCount: { type: 'integer', title: 'Required count' },
      optionalLimit: { type: 'number', title: 'Optional limit' },
      enabled: { type: 'boolean', title: 'Enabled' },
      mode: { type: 'string', title: 'Mode', enum: ['safe', 'fast'] },
    },
  },
};

function editorHandlers(
  onSave: (request: Request, body: { graph: typeof emptyGraph }) => void,
  options: Readonly<{
    graph?: WorkflowGraphContract;
    definitions?: readonly NodeDefinitionCatalogItem[];
  }> = {},
) {
  const initialGraph = options.graph ?? emptyGraph;
  const definitions = options.definitions ?? [definition];
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({ schemaVersion: 1, release, items: definitions }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({ schemaVersion: 1, release, items: [] }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
      () =>
        HttpResponse.json(
          {
            workflowId,
            revision: 1,
            schemaVersion: 1,
            graph: initialGraph,
            compatibility,
            updatedAt: '2026-09-14T10:00:00.000Z',
          },
          { headers: { etag: etagA } },
        ),
    ),
    http.put(
      `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
      async ({ request }) => {
        const body = await request.clone().json();
        if (!isGraphRequest(body))
          return HttpResponse.json({}, { status: 400 });
        onSave(request, body);
        return HttpResponse.json(
          {
            workflowId,
            revision: 2,
            schemaVersion: 1,
            graph: body.graph,
            compatibility,
            updatedAt: '2026-09-14T10:01:00.000Z',
          },
          { headers: { etag: etagB } },
        );
      },
    ),
  ];
}

describe('workflow editor route', () => {
  it('creates typed input mappings through the inspector and saves them through the draft pipeline', async () => {
    const graph = graphWithMappingNodes();
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        { graph, definitions: [manualDefinition, mappingDefinition] },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
        () =>
          HttpResponse.json({
            workflow: {
              id: workflowId,
              workspaceId,
              name: 'Mapping workflow',
              lifecycleStatus: 'active',
              lifecycleRevision: 1,
              activationStatus: 'inactive',
              publishedVersionId: null,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    fireEvent.click(
      within(await screen.findByRole('application')).getByText('Target'),
    );
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    expect(within(inputs).getByText(/No input mappings/u)).toBeVisible();

    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    const rows = within(inputs).getAllByRole('listitem');
    const customerRow = rows[0];
    const requestedByRow = rows[1];
    const activeRow = rows[2];
    if (
      customerRow === undefined ||
      requestedByRow === undefined ||
      activeRow === undefined
    )
      throw new Error('expected three mapping rows');

    await event.type(
      within(customerRow).getByLabelText('Destination key'),
      'customer',
    );
    await event.selectOptions(
      within(customerRow).getByLabelText('Source'),
      'node_output',
    );
    await event.selectOptions(
      within(customerRow).getByLabelText('Source node'),
      'manual',
    );
    await event.clear(within(customerRow).getByLabelText('Output path'));
    await event.type(
      within(customerRow).getByLabelText('Output path'),
      '$.customer',
    );

    await event.type(
      within(requestedByRow).getByLabelText('Destination key'),
      'requestedBy',
    );
    await event.selectOptions(
      within(requestedByRow).getByLabelText('Source'),
      'run_input',
    );
    await event.clear(within(requestedByRow).getByLabelText('Run input path'));
    await event.type(
      within(requestedByRow).getByLabelText('Run input path'),
      '$.actor.name',
    );

    await event.type(
      within(activeRow).getByLabelText('Destination key'),
      'active',
    );
    fireEvent.change(within(activeRow).getByLabelText('JSON value'), {
      target: { value: 'true' },
    });
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeEnabled();
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    await event.click(screen.getByRole('button', { name: 'Save now' }));
    await waitFor(() => {
      expect(savedGraph?.nodes[1]?.inputMappings).toEqual({
        customer: {
          kind: 'node_output',
          nodeId: 'manual',
          path: '$.customer',
        },
        requestedBy: { kind: 'run_input', path: '$.actor.name' },
        active: { kind: 'literal', value: true },
      });
    });
    expect(await screen.findByText('Saved')).toBeVisible();

    await event.click(screen.getByRole('button', { name: 'Undo' }));
    expect(
      within(screen.getByRole('region', { name: 'Inputs' })).getByText(
        /No input mappings/u,
      ),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Redo' }));
    expect(
      within(screen.getByRole('region', { name: 'Inputs' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(3);
  });

  it('keeps invalid and advanced mapping scratch explicit across Apply and Cancel', async () => {
    const graph = graphWithMappingNodes({
      expression: {
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.customer',
        policyVersion: 1,
      },
    });
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph,
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    fireEvent.click(
      within(await screen.findByRole('application')).getByText('Target'),
    );
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    expect(within(inputs).getByText(/JSONata expression/u)).toBeVisible();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await event.click(within(inputs).getByRole('button', { name: 'Remove' }));
    expect(within(inputs).getByText(/JSONata expression/u)).toBeVisible();
    await event.click(within(inputs).getByRole('button', { name: 'Remove' }));
    expect(within(inputs).queryByText(/JSONata expression/u)).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(2);
    await event.click(screen.getByRole('button', { name: 'Cancel changes' }));
    expect(within(inputs).getByText(/JSONata expression/u)).toBeVisible();
    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    const rows = within(inputs).getAllByRole('listitem');
    const invalidRow = rows.at(-1);
    if (invalidRow === undefined) throw new Error('expected an added row');
    fireEvent.change(within(invalidRow).getByLabelText('JSON value'), {
      target: { value: '{' },
    });
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(within(invalidRow).getByLabelText('Destination key')).toHaveFocus();
    expect(
      within(invalidRow).getByText('Destination key is required.'),
    ).toBeVisible();
    expect(
      within(invalidRow).getByText('Literal value must be valid JSON.'),
    ).toBeVisible();

    await event.click(screen.getByRole('button', { name: 'Cancel changes' }));
    expect(within(inputs).getAllByRole('listitem')).toHaveLength(1);
    expect(within(inputs).getByText(/JSONata expression/u)).toBeVisible();
  });

  it('keeps a disconnected node-output mapping visible and repairs it only when reconnected', async () => {
    const graph = {
      ...graphWithMappingNodes({
        customer: {
          kind: 'node_output',
          nodeId: 'manual',
          path: '$.customer',
        },
      }),
      edges: [],
    };
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph,
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    fireEvent.click(
      within(await screen.findByRole('application')).getByText('Target'),
    );
    expect(
      screen.getByText('The source must be a directly connected predecessor.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Source node')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Destination key')).toHaveValue('customer');

    await event.selectOptions(
      screen.getByLabelText('Connect from node'),
      'manual',
    );
    await event.selectOptions(screen.getByLabelText('Source output'), 'out');
    await event.selectOptions(screen.getByLabelText('Target input'), 'in');
    await event.click(screen.getByRole('button', { name: 'Connect nodes' }));
    expect(
      screen.queryByText(
        'The source must be a directly connected predecessor.',
      ),
    ).toBeNull();
    expect(screen.getByLabelText('Source node')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    expect(screen.getByLabelText('Destination key')).toHaveValue('customer');
  });

  it('protects unapplied mapping scratch during in-page node selection', async () => {
    const graph = graphWithMappingNodes();
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph,
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    const canvas = within(await screen.findByRole('application'));
    fireEvent.click(canvas.getByText('Target'));
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    await event.type(
      within(inputs).getByLabelText('Destination key'),
      'scratch',
    );

    fireEvent.click(canvas.getByText('Manual input'));
    expect(
      await screen.findByRole('heading', { name: 'Resolve unapplied changes' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Stay' }));
    expect(within(inputs).getByLabelText('Destination key')).toHaveValue(
      'scratch',
    );

    fireEvent.click(canvas.getByText('Manual input'));
    await event.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(
      screen.getByText(/receives the accepted run input directly/u),
    ).toBeVisible();
    fireEvent.click(canvas.getByText('Target'));
    expect(
      within(screen.getByRole('region', { name: 'Inputs' })).getByText(
        /No input mappings/u,
      ),
    ).toBeVisible();
  });

  it('continues autosaving after the StrictMode effect lifecycle replay', async () => {
    let savedNodes = 0;
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedNodes = body.graph.nodes.length;
      }),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /core\.set/u }),
    );
    await waitFor(
      () => {
        expect(savedNodes).toBe(1);
      },
      { timeout: 3_000 },
    );
    expect(await screen.findByText('Saved')).toBeVisible();
  });

  it('continues manual saving after the StrictMode effect lifecycle replay', async () => {
    let savedNodes = 0;
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedNodes = body.graph.nodes.length;
      }),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /core\.set/u }),
    );
    await event.click(screen.getByRole('button', { name: 'Save now' }));
    await waitFor(() => {
      expect(savedNodes).toBe(1);
    });
    expect(await screen.findByText('Saved')).toBeVisible();
  });

  it('places a catalog node and conditionally autosaves the domain graph', async () => {
    let savedNodes = 0;
    mockServer.use(
      ...editorHandlers((request, body) => {
        expect(request.headers.get('if-match')).toBe(etagA);
        expect(request.headers.get('x-csrf-token')).toBeTruthy();
        savedNodes = body.graph.nodes.length;
      }),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /core\.set/u }),
    );
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    await waitFor(
      () => {
        expect(savedNodes).toBe(1);
      },
      { timeout: 3_000 },
    );
    expect(await screen.findByText('Saved')).toBeVisible();
    expect(screen.getByText('core.set@1')).toBeInTheDocument();
  });

  it('lets advanced JSON add, edit and remove numeric properties without stale control overlays', async () => {
    const graph = graphWithNumericConfig({
      count: 4,
      requiredCount: 1,
      unknown: { preserved: true },
    });
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        { graph, definitions: [numericDefinition] },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    fireEvent.click(
      within(await screen.findByRole('application')).getByText('core.set@1'),
    );
    const advancedJson = screen.getByLabelText('Configuration');
    fireEvent.change(advancedJson, {
      target: {
        value: JSON.stringify(
          {
            count: 9,
            requiredCount: 1,
            optionalLimit: 2,
            unknown: { preserved: true },
          },
          null,
          2,
        ),
      },
    });
    expect(screen.getByLabelText('Count')).toHaveValue('9');
    expect(screen.getByLabelText('Optional limit')).toHaveValue('2');

    fireEvent.change(advancedJson, {
      target: {
        value: JSON.stringify(
          {
            requiredCount: 1,
            optionalLimit: 3,
            unknown: { preserved: true },
          },
          null,
          2,
        ),
      },
    });
    expect(screen.getByLabelText('Count')).toHaveValue('');
    expect(screen.getByLabelText('Optional limit')).toHaveValue('3');
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Save now' }));
    expect(await screen.findByText('Saved')).toBeVisible();
    await waitFor(
      () => {
        expect(savedGraph?.nodes[0]?.config).toEqual({
          requiredCount: 1,
          optionalLimit: 3,
          unknown: { preserved: true },
        });
      },
      { timeout: 3_000 },
    );
  });

  it('combines numeric-control and JSON edits while retaining incomplete scratch until Apply or Cancel', async () => {
    const originalConfig = {
      count: 4,
      requiredCount: 1,
      unknown: { preserved: true },
    };
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: graphWithNumericConfig(originalConfig),
          definitions: [numericDefinition],
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    fireEvent.click(
      within(await screen.findByRole('application')).getByText('core.set@1'),
    );
    const count = screen.getByLabelText('Count');
    const advancedJson = screen.getByLabelText('Configuration');
    fireEvent.change(count, { target: { value: '0' } });
    fireEvent.change(advancedJson, {
      target: {
        value: JSON.stringify({
          count: 0,
          requiredCount: 1,
          unknown: { preserved: true, addedInJson: true },
        }),
      },
    });
    expect(count).toHaveValue('0');

    fireEvent.change(count, { target: { value: '-' } });
    fireEvent.change(advancedJson, {
      target: {
        value: JSON.stringify({
          count: 0,
          requiredCount: 1,
          unknown: { preserved: true, addedInJson: 'again' },
        }),
      },
    });
    expect(count).toHaveValue('-');
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.getByText('Count must be a valid number.')).toBeVisible();
    expect(savedGraph).toBeUndefined();

    await event.click(screen.getByRole('button', { name: 'Cancel changes' }));
    expect(count).toHaveValue('4');
    expect(advancedJson).toHaveValue(JSON.stringify(originalConfig, null, 2));
    fireEvent.change(count, { target: { value: '-2.5' } });
    fireEvent.change(advancedJson, {
      target: {
        value: JSON.stringify({
          count: -2.5,
          requiredCount: 1,
          unknown: { preserved: true, addedInJson: true },
        }),
      },
    });
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Save now' }));
    expect(await screen.findByText('Saved')).toBeVisible();
    await waitFor(
      () => {
        expect(savedGraph?.nodes[0]?.config).toEqual({
          count: -2.5,
          requiredCount: 1,
          unknown: { preserved: true, addedInJson: true },
        });
      },
      { timeout: 3_000 },
    );
  });

  it('keeps invalid advanced JSON intact while ordinary fields own explicit scratch edits', async () => {
    const originalConfig = {
      value: 'saved',
      enabled: false,
      mode: 'safe',
      requiredCount: 1,
      unknown: { preserved: true },
    };
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: graphWithNumericConfig(originalConfig),
          definitions: [numericDefinition],
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    fireEvent.click(
      within(await screen.findByRole('application')).getByText('core.set@1'),
    );
    const advancedJson = screen.getByLabelText('Configuration');
    const unfinished = '{"value":"unfinished","unknown":{"draft":';
    fireEvent.change(advancedJson, { target: { value: unfinished } });
    await event.clear(screen.getByLabelText('Value'));
    await event.type(screen.getByLabelText('Value'), 'field edit');
    await event.click(screen.getByLabelText('Enabled'));
    await event.selectOptions(screen.getByLabelText('Mode'), 'fast');

    expect(advancedJson).toHaveValue(unfinished);
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(
      screen.getByText('Configuration must be a valid JSON object.'),
    ).toBeVisible();
    expect(savedGraph).toBeUndefined();

    await event.click(screen.getByRole('button', { name: 'Cancel changes' }));
    expect(advancedJson).toHaveValue(JSON.stringify(originalConfig, null, 2));
    expect(screen.getByLabelText('Value')).toHaveValue('saved');
    expect(screen.getByLabelText('Enabled')).not.toBeChecked();
    expect(screen.getByLabelText('Mode')).toHaveValue('safe');

    fireEvent.change(advancedJson, { target: { value: unfinished } });
    await event.clear(screen.getByLabelText('Value'));
    await event.type(screen.getByLabelText('Value'), 'field edit');
    await event.click(screen.getByLabelText('Enabled'));
    await event.selectOptions(screen.getByLabelText('Mode'), 'fast');

    fireEvent.change(advancedJson, {
      target: {
        value: JSON.stringify({
          value: 'saved',
          enabled: false,
          mode: 'safe',
          requiredCount: 1,
          unknown: { preserved: true, repaired: true },
        }),
      },
    });
    await event.click(screen.getByRole('button', { name: 'Apply changes' }));
    await event.click(screen.getByRole('button', { name: 'Save now' }));
    await waitFor(() => {
      expect(savedGraph?.nodes[0]?.config).toEqual({
        value: 'field edit',
        enabled: true,
        mode: 'fast',
        requiredCount: 1,
        unknown: { preserved: true, repaired: true },
      });
    });
  });

  it('freezes autosave, manual save and queued validation when the session identity changes', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    let currentUser = user;
    let saveCalls = 0;
    let validationCalls = 0;
    mockServer.use(
      ...editorHandlers(() => {
        saveCalls += 1;
      }),
    );
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(currentUser),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () => {
          validationCalls += 1;
          return HttpResponse.json({ valid: true, issues: [], compatibility });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    await screen.findByRole('button', { name: /core\.set/u });
    currentUser = otherUser;
    await event.click(screen.getByRole('button', { name: /core\.set/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    expect(saveCalls).toBe(0);
    expect(validationCalls).toBe(0);

    currentUser = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Save now' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Save now' }));
    await waitFor(() => {
      expect(saveCalls).toBe(1);
    });
  });

  it('aborts an in-flight draft write when identity observation changes', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    let currentUser = user;
    let saveStarted = 0;
    let requestAborted = false;
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(currentUser),
      ),
      http.put(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
        async ({ request }) => {
          saveStarted += 1;
          request.signal.addEventListener('abort', () => {
            requestAborted = true;
          });
          await saveGate;
          return HttpResponse.json(
            {
              workflowId,
              revision: 2,
              schemaVersion: 1,
              graph: emptyGraph,
              compatibility,
              updatedAt: '2026-09-14T10:01:00.000Z',
            },
            { headers: { etag: etagB } },
          );
        },
      ),
    );
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}`,
      { strict: true },
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /core\.set/u }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
    await waitFor(() => {
      expect(saveStarted).toBe(1);
    });
    currentUser = otherUser;
    await queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(requestAborted).toBe(true);
    });
    releaseSave?.();
  });

  it('retains an exact uncertain run through an identity pause until explicit retry', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const publishedVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    let identity: 'original' | 'different' | 'unverified' = 'original';
    const requests: Readonly<{ body: unknown; key: string | null }>[] = [];
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        if (identity === 'unverified')
          return HttpResponse.json(
            {
              type: 'urn:pertexo:problem:service.unavailable',
              title: 'Service unavailable',
              status: 503,
              code: 'service.unavailable',
              requestId: 'identity-temporarily-unavailable',
            },
            {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        return HttpResponse.json(identity === 'different' ? otherUser : user);
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        async ({ request }) => {
          requests.push({
            body: await request.clone().json(),
            key: request.headers.get('idempotency-key'),
          });
          if (requests.length === 1) return HttpResponse.error();
          return HttpResponse.json({
            run: runSummary(runId, publishedVersionId, 'queued'),
            replayed: true,
          });
        },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}`,
        () =>
          HttpResponse.json({
            run: runSummary(runId, publishedVersionId, 'queued'),
            nodes: [],
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}/events`,
        () =>
          new HttpResponse('', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
      target: { value: '{"customerId":"customer-7"}' },
    });
    fireEvent.change(screen.getByLabelText('Deadline (optional)'), {
      target: { value: '2026-09-20T12:30' },
    });
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = 'unverified';
    await event.click(screen.getByRole('button', { name: 'Retry same run' }));
    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = 'different';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry same run' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Run input (JSON)')).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);

    identity = 'original';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    expect(
      screen.getByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry same run' }));

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[0]?.body).toMatchObject({
      input: { customerId: 'customer-7' },
      deadlineAt: new Date('2026-09-20T12:30').toISOString(),
    });
    expect(requests[1]).toEqual(requests[0]);
  });

  it('retains an exact uncertain publish through an identity pause until explicit retry', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const publishedVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    let identity: 'original' | 'different' | 'unverified' = 'original';
    const requests: Readonly<{
      body: string;
      etag: string | null;
      key: string | null;
    }>[] = [];
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        if (identity === 'unverified') return HttpResponse.error();
        return HttpResponse.json(identity === 'different' ? otherUser : user);
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () => HttpResponse.json({ valid: true, issues: [], compatibility }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
        async ({ request }) => {
          requests.push({
            body: await request.clone().text(),
            etag: request.headers.get('if-match'),
            key: request.headers.get('idempotency-key'),
          });
          if (requests.length === 1) return HttpResponse.error();
          return HttpResponse.json({
            version: {
              id: publishedVersionId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph: emptyGraph,
              checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
              publishedAt: '2026-09-14T10:02:00.000Z',
            },
            reused: true,
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation: valid')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    await event.click(screen.getByRole('button', { name: 'Publish version' }));
    expect(
      await screen.findByRole('button', { name: 'Retry original publish' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = 'unverified';
    await event.click(
      screen.getByRole('button', { name: 'Retry original publish' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = 'different';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    identity = 'original';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await event.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(
      screen.getByRole('button', { name: 'Retry original publish' }),
    ).toBeVisible();
    await event.click(
      screen.getByRole('button', { name: 'Retry original publish' }),
    );

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]).toMatchObject({ body: '', etag: etagA });
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(
      await screen.findByText(`Published ${publishedVersionId}`),
    ).toBeVisible();
  });

  it('does not trust cached original-user data when fresh recovery verification fails', async () => {
    let identity: 'original' | 'unavailable' | 'network' | 'unauthorized' =
      'original';
    let runRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        if (identity === 'original') return HttpResponse.json(user);
        if (identity === 'network') return HttpResponse.error();
        return HttpResponse.json(
          {
            type:
              identity === 'unauthorized'
                ? 'urn:pertexo:problem:auth.required'
                : 'urn:pertexo:problem:service.unavailable',
            title:
              identity === 'unauthorized'
                ? 'Authentication required'
                : 'Service unavailable',
            status: identity === 'unauthorized' ? 401 : 503,
            code:
              identity === 'unauthorized'
                ? 'auth.required'
                : 'service.unavailable',
            requestId: `identity-${identity}`,
          },
          {
            status: identity === 'unauthorized' ? 401 : 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        () => {
          runRequests += 1;
          return HttpResponse.error();
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();

    identity = 'unavailable';
    await event.click(screen.getByRole('button', { name: 'Retry same run' }));
    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    identity = 'network';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    identity = 'unauthorized';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);

    identity = 'original';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    expect(
      screen.getByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);
  });

  it('retains a run accepted during a pause until the verified user explicitly opens it', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const publishedVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const accepted = deferred<Response>();
    let identity = user;
    let runRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(identity),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        () => {
          runRequests += 1;
          return accepted.promise;
        },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}`,
        () =>
          HttpResponse.json({
            run: runSummary(runId, publishedVersionId, 'queued'),
            nodes: [],
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}/events`,
        () =>
          new HttpResponse('', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const app = renderApp(`/w/${workspaceId}/workflows/${workflowId}`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    await waitFor(() => {
      expect(runRequests).toBe(1);
    });

    identity = otherUser;
    await app.queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    accepted.resolve(
      HttpResponse.json({
        run: runSummary(runId, publishedVersionId, 'queued'),
        replayed: false,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/workflows/${workflowId}`,
    );

    identity = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    const openAccepted = await screen.findByRole('button', {
      name: 'Open accepted run',
    });
    expect(runRequests).toBe(1);
    await event.click(screen.getByRole('button', { name: /core\.set/u }));
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    await event.click(openAccepted);
    expect(
      await screen.findByRole('heading', {
        name: 'Leave with unapplied changes?',
      }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/workflows/${workflowId}`,
    );
    await event.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(
      screen.getByRole('button', { name: 'Open accepted run' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);

    await event.click(screen.getByRole('button', { name: 'Save now' }));
    expect(await screen.findByText('Saved')).toBeVisible();
    await event.click(
      screen.getByRole('button', { name: 'Open accepted run' }),
    );
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${runId}`,
      );
    });
    expect(runRequests).toBe(1);
  });

  it('retains a late publish receipt through a pause without replaying publication', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const publishedVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const accepted = deferred<Response>();
    let identity = user;
    let publishRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(identity),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () => HttpResponse.json({ valid: true, issues: [], compatibility }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
        () => {
          publishRequests += 1;
          return accepted.promise;
        },
      ),
    );
    const app = renderApp(`/w/${workspaceId}/workflows/${workflowId}`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Validate' }));
    await screen.findByText('Validation: valid');
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    await event.click(screen.getByRole('button', { name: 'Publish version' }));
    await waitFor(() => {
      expect(publishRequests).toBe(1);
    });

    identity = otherUser;
    await app.queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    expect(
      await screen.findByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    accepted.resolve(
      HttpResponse.json({
        version: {
          id: publishedVersionId,
          workflowId,
          versionNumber: 1,
          schemaVersion: 1,
          graph: emptyGraph,
          checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
          publishedAt: '2026-09-14T10:02:00.000Z',
        },
        reused: false,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(screen.queryByText(`Published ${publishedVersionId}`)).toBeNull();

    identity = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      await screen.findByText(`Published ${publishedVersionId}`),
    ).toBeVisible();
    expect(publishRequests).toBe(1);
  });

  it('retains a late uncertain run outcome through a pause for explicit recovery', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const response = deferred<Response>();
    let identity = user;
    let runRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(identity),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        () => {
          runRequests += 1;
          return response.promise;
        },
      ),
    );
    const app = renderApp(`/w/${workspaceId}/workflows/${workflowId}`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    await waitFor(() => {
      expect(runRequests).toBe(1);
    });

    identity = otherUser;
    await app.queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    await screen.findByRole('heading', { name: 'Editor paused' });
    response.resolve(HttpResponse.error());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();

    identity = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    expect(
      screen.getByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);
  });

  it('fences a pending verification and command when the routed editor is disposed', async () => {
    const otherUser = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const identityResponse = deferred<Response>();
    const runResponse = deferred<Response>();
    let identityMode: 'original' | 'different' | 'deferred' = 'original';
    let verificationAborted = false;
    let runRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', ({ request }) => {
        if (identityMode === 'deferred') {
          request.signal.addEventListener('abort', () => {
            verificationAborted = true;
          });
          return identityResponse.promise;
        }
        return HttpResponse.json(
          identityMode === 'different' ? otherUser : user,
        );
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        () => {
          runRequests += 1;
          return runResponse.promise;
        },
      ),
    );
    const first = renderApp(`/w/${workspaceId}/workflows/${workflowId}`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    await waitFor(() => {
      expect(runRequests).toBe(1);
    });
    identityMode = 'different';
    await first.queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    await screen.findByRole('heading', { name: 'Editor paused' });
    identityMode = 'deferred';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    first.unmount();
    await waitFor(() => {
      expect(verificationAborted).toBe(true);
    });
    identityResponse.resolve(HttpResponse.json(user));
    runResponse.resolve(
      HttpResponse.json({
        run: runSummary(
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          'queued',
        ),
        replayed: false,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    identityMode = 'original';
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`, { strict: true });
    expect(
      await screen.findByRole('button', { name: 'Start run' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Open accepted run' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry same run' }),
    ).not.toBeInTheDocument();
    expect(runRequests).toBe(1);
  });

  it('disposes retained command recovery when the routed editor scope exits', async () => {
    let runRequests = 0;
    let publishRequests = 0;
    mockServer.use(
      ...editorHandlers(() => undefined),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () => HttpResponse.json({ valid: true, issues: [], compatibility }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
        () => {
          publishRequests += 1;
          return HttpResponse.error();
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        () => {
          runRequests += 1;
          return HttpResponse.error();
        },
      ),
    );
    const first = renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation: valid')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    await event.click(screen.getByRole('button', { name: 'Publish version' }));
    expect(
      await screen.findByRole('button', { name: 'Retry original publish' }),
    ).toBeVisible();
    expect(publishRequests).toBe(1);
    first.unmount();

    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    expect(
      screen.getByRole('button', { name: 'Start published version' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry same run' }),
    ).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    expect(
      screen.getByRole('button', { name: 'Publish version' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry original publish' }),
    ).not.toBeInTheDocument();
  });

  it('renders validation findings and navigates to resolvable fields through dirty guards', async () => {
    let savedNodeId = '';
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedNodeId = body.graph.nodes[0]?.id ?? '';
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () =>
          HttpResponse.json({
            valid: false,
            issues: [
              {
                path: `$.nodes.${savedNodeId}.config.value`,
                code: 'invalid_config',
                message: 'Value is required for this node.',
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
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /core\.set/u }),
    );
    await waitFor(() => {
      expect(savedNodeId).not.toBe('');
    });
    expect(await screen.findByText('Saved')).toBeVisible();
    await event.click(await screen.findByRole('button', { name: 'Validate' }));
    expect(
      await screen.findByText('Value is required for this node.'),
    ).toBeVisible();
    expect(
      screen.getByText('The workflow also has a general issue.'),
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: /Go to/u })).toHaveLength(1);

    await event.click(screen.getByRole('button', { name: 'Go to value' }));
    expect(screen.getByLabelText('Value')).toHaveFocus();
    await event.type(screen.getByLabelText('Label'), 'Scratch label');
    await event.click(screen.getByRole('button', { name: 'Go to value' }));
    expect(
      screen.getByRole('heading', { name: 'Resolve unapplied changes' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('Label')).toHaveValue('Scratch label');
  });

  it('renders compatibility findings and navigates to a matching unsupported node', async () => {
    const graph: WorkflowGraphContract = {
      ...emptyGraph,
      nodes: [
        {
          id: 'node-unsupported',
          definition: { key: 'core.retired', version: 7 },
          position: { x: 80, y: 80 },
          configVersion: 1,
          config: { unknown: { preserved: true } },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
    };
    mockServer.use(
      ...editorHandlers(() => undefined, { graph }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () =>
          HttpResponse.json({
            valid: false,
            issues: [],
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
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Validate' }));

    expect(await screen.findByText('Validation: 1 finding')).toBeVisible();
    expect(
      screen.getByText(
        'Definition core.retired@7 is not available in the current catalog.',
      ),
    ).toBeVisible();
    await event.click(
      screen.getByRole('button', { name: 'Go to matching node' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveFocus();
    });
    expect(screen.getByText('Unsupported')).toBeVisible();
  });

  it('retries failed workflow metadata without replacing unapplied inspector scratch', async () => {
    let metadataAvailable = false;
    const graph = graphWithMappingNodes();
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph,
        definitions: [manualDefinition, mappingDefinition],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
        () =>
          metadataAvailable
            ? HttpResponse.json({
                workflow: {
                  id: workflowId,
                  workspaceId,
                  name: 'Recovered workflow name',
                  lifecycleStatus: 'active',
                  lifecycleRevision: 1,
                  activationStatus: 'inactive',
                  publishedVersionId: null,
                  createdAt: user.createdAt,
                  updatedAt: user.updatedAt,
                },
              })
            : HttpResponse.json({}, { status: 500 }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    expect(
      await screen.findByRole('heading', {
        name: 'Workflow name unavailable',
      }),
    ).toBeVisible();
    fireEvent.click(
      within(screen.getByRole('application')).getByText('Target'),
    );
    await event.clear(screen.getByLabelText('Label'));
    await event.type(screen.getByLabelText('Label'), 'Unapplied scratch');

    metadataAvailable = true;
    await event.click(screen.getByRole('button', { name: 'Retry name' }));
    expect(
      await screen.findByRole('heading', { name: 'Recovered workflow name' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Label')).toHaveValue('Unapplied scratch');
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeEnabled();
  });

  it('navigates authoritative mapping findings to the matching input row', async () => {
    const graph = graphWithMappingNodes({
      customer: {
        kind: 'node_output',
        nodeId: 'manual',
        path: '$.customer',
      },
    });
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph,
        definitions: [manualDefinition, mappingDefinition],
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () =>
          HttpResponse.json({
            valid: false,
            issues: [
              {
                path: '$.nodes.target.inputMappings.customer',
                code: 'invalid_mapping',
                message: 'Customer must come from a direct predecessor.',
              },
            ],
            compatibility,
          }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Validate' }));
    await event.click(
      await screen.findByRole('button', { name: 'Go to customer input' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Destination key')).toHaveFocus();
    });
    expect(screen.getByLabelText('Destination key')).toHaveValue('customer');
  });

  it('associates run-start validation with the input and focuses it', async () => {
    mockServer.use(...editorHandlers(() => undefined));
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Start run' }));
    const input = screen.getByLabelText('Run input (JSON)');
    fireEvent.change(input, { target: { value: '{' } });
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Run input must be valid JSON.');
    fireEvent.change(input, { target: { value: '{}' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('saves, validates and publishes before showing the exact accepted run version', async () => {
    const publishedVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    let savedGraph = emptyGraph;
    let currentRevision = 1;
    let currentEtag = etagA;
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedGraph = body.graph;
        currentRevision = 2;
        currentEtag = etagB;
      }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
        () => HttpResponse.json({ valid: true, issues: [], compatibility }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
        ({ request }) => {
          expect(request.headers.get('if-match')).toBe(etagB);
          expect(request.headers.get('idempotency-key')).toBeTruthy();
          return HttpResponse.json({
            version: {
              id: publishedVersionId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph: savedGraph,
              checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
              publishedAt: '2026-09-14T10:02:00.000Z',
            },
            reused: false,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        ({ request }) => {
          expect(request.headers.get('idempotency-key')).toBeTruthy();
          return HttpResponse.json({
            run: runSummary(runId, publishedVersionId, 'queued'),
            replayed: false,
          });
        },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}`,
        () =>
          HttpResponse.json({
            run: runSummary(runId, publishedVersionId, 'succeeded'),
            nodes: [],
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
        () =>
          HttpResponse.json({
            items: [
              {
                id: publishedVersionId,
                workflowId,
                versionNumber: 1,
                schemaVersion: 1,
                graph: savedGraph,
                checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
                publishedAt: '2026-09-14T10:02:00.000Z',
              },
            ],
            nextCursor: null,
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}/events`,
        () =>
          new HttpResponse(
            `id: 1\nevent: run.succeeded\ndata: ${JSON.stringify({
              sequence: 1,
              type: 'run.succeeded',
              createdAt: '2026-09-14T10:03:00.000Z',
              payload: { schemaVersion: 1 },
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    const event = userEvent.setup();

    await event.click(
      await screen.findByRole('button', { name: /core\.set/u }),
    );
    await screen.findByText('Saved');
    expect(currentRevision).toBe(2);
    expect(currentEtag).toBe(etagB);
    await event.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation: valid')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    await event.click(screen.getByRole('button', { name: 'Publish version' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText(`Published ${publishedVersionId}`)).toBeVisible();
    const paletteButton = screen.getAllByRole('button', {
      name: /core\.set/u,
    })[0];
    if (paletteButton === undefined) throw new Error('Node palette is missing');
    await event.click(paletteButton);
    expect(
      screen.getByText(
        `Published ${publishedVersionId} · subsequent edits unpublished`,
      ),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Start run' }));
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );

    expect(await screen.findByText('Accepted workflow version')).toBeVisible();
    expect(screen.getByText(publishedVersionId)).toBeVisible();
    expect(screen.getByText('succeeded')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Execution map' }),
    ).toBeVisible();
  });
});

function runSummary(
  runId: string,
  workflowVersionId: string,
  status: 'queued' | 'succeeded',
) {
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId,
    status,
    triggerType: 'manual',
    createdAt: '2026-09-14T10:02:00.000Z',
    updatedAt: '2026-09-14T10:03:00.000Z',
    startedAt: '2026-09-14T10:02:01.000Z',
    completedAt: status === 'succeeded' ? '2026-09-14T10:03:00.000Z' : null,
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

function isGraphRequest(value: unknown): value is { graph: typeof emptyGraph } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'graph' in value &&
    typeof Reflect.get(value, 'graph') === 'object'
  );
}

function graphWithNumericConfig(
  config: WorkflowGraphContract['nodes'][number]['config'],
): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        definition: { key: 'core.set', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config,
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
}

function graphWithMappingNodes(
  inputMappings: WorkflowGraphContract['nodes'][number]['inputMappings'] = {},
): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
        label: 'Manual input',
      },
      {
        id: 'target',
        definition: { key: 'core.set', version: 1 },
        position: { x: 340, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs: {},
        label: 'Target',
      },
    ],
    edges: [
      {
        id: 'manual-target',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'target', port: 'in' },
      },
    ],
    settings: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
