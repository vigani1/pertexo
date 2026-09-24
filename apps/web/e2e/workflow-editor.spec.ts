import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const csrfToken = 'csrf-token-for-editor-tests-123456789012345678901234';
const etags = [
  `"draft-v1.${'a'.repeat(43)}"`,
  `"draft-v1.${'b'.repeat(43)}"`,
  `"draft-v1.${'c'.repeat(43)}"`,
] as const;
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
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
const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};
const definition = {
  schemaVersion: 1,
  definition: { key: 'core.set', version: 1 },
  family: 'transform',
  configVersion: 1,
  configSchema: {
    type: 'object',
    properties: {
      value: { type: 'string', title: 'Value' },
      count: { type: 'number', title: 'Count' },
    },
  },
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
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
};
const manualDefinition = {
  ...definition,
  definition: { key: 'core.manual', version: 1 },
  family: 'trigger',
  inputSchema: {},
  ports: { inputs: [], outputs: ['out'] },
};

type Graph = Readonly<{
  schemaVersion: number;
  nodes: readonly unknown[];
  edges: readonly unknown[];
  settings: Readonly<Record<string, unknown>>;
}>;

interface RemoteDraft {
  graph: Graph;
  revision: number;
  etagIndex: number;
}

async function installEditorRoutes(
  page: Page,
  remote: RemoteDraft,
  accessibleWorkspace = workspace,
  definitions: readonly unknown[] = [definition],
  workflowName = 'Customer onboarding',
) {
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: { items: [accessibleWorkspace], nextCursor: null },
    }),
  );
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: definitions } }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: [] } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({
        json: {
          workflow: {
            id: workflowId,
            workspaceId,
            name: workflowName,
            lifecycleStatus: 'active',
            lifecycleRevision: 1,
            activationStatus: 'inactive',
            publishedVersionId: null,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          headers: {
            'content-type': 'application/json',
            etag: currentEtag(remote),
          },
          body: JSON.stringify(draftBody(remote)),
        });
        return;
      }
      expect(request.method()).toBe('PUT');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      const ifMatch = request.headers()['if-match'];
      if (ifMatch !== currentEtag(remote)) {
        await route.fulfill({
          status: 412,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'urn:pertexo:problem:workflow.revision_conflict',
            title: 'Workflow revision conflict',
            status: 412,
            code: 'workflow.revision_conflict',
            requestId: 'request-editor-conflict',
            currentRevision: remote.revision,
            currentEtag: currentEtag(remote),
          }),
        });
        return;
      }
      const body = parseGraphRequest(request.postData());
      if (body === null) {
        await route.fulfill({ status: 400, json: {} });
        return;
      }
      remote.graph = body.graph;
      remote.revision += 1;
      remote.etagIndex = Math.min(remote.etagIndex + 1, etags.length - 1);
      await route.fulfill({
        headers: {
          'content-type': 'application/json',
          etag: currentEtag(remote),
        },
        body: JSON.stringify(draftBody(remote)),
      });
    },
  );
}

test('edits typed input mappings, saves them and restores rendered controls after reload', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: mappingGraph(),
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, workspace, [
    manualDefinition,
    definition,
  ]);
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await expect(
    page.getByRole('heading', { name: 'Customer onboarding' }),
  ).toBeVisible();
  await page.getByTestId('rf__node-target').click();
  const inputs = page.getByRole('region', { name: 'Inputs' });
  await inputs.getByRole('button', { name: 'Add input' }).click();
  await inputs.getByRole('button', { name: 'Add input' }).click();
  await inputs.getByRole('button', { name: 'Add input' }).click();
  const rows = inputs.getByRole('listitem');

  await rows.nth(0).getByLabel('Destination key').fill('customer');
  await rows.nth(0).getByLabel('Source').selectOption('node_output');
  await rows.nth(0).getByLabel('Source node').selectOption('manual');
  await rows.nth(0).getByLabel('Output path').fill('$.customer');

  await rows.nth(1).getByLabel('Destination key').fill('requestedBy');
  await rows.nth(1).getByLabel('Source').selectOption('run_input');
  await rows.nth(1).getByLabel('Run input path').fill('$.actor.name');

  await rows.nth(2).getByLabel('Destination key').fill('payload');
  await rows
    .nth(2)
    .getByLabel('JSON value')
    .fill('{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);
  await expect(page.getByText('Saved')).toBeVisible();
  expect(remote.graph.nodes[1]).toMatchObject({
    inputMappings: {
      customer: {
        kind: 'node_output',
        nodeId: 'manual',
        path: '$.customer',
      },
      requestedBy: { kind: 'run_input', path: '$.actor.name' },
      payload: {
        kind: 'literal',
      },
    },
  });
  expect(JSON.stringify(remote.graph)).toContain(
    '"payload":{"kind":"literal","value":{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}}',
  );

  await page.reload();
  await page.getByTestId('rf__node-target').click();
  const restored = page.getByRole('region', { name: 'Inputs' });
  await expect(restored.getByRole('listitem')).toHaveCount(3);
  await expect(
    restored.getByRole('listitem').nth(0).getByLabel('Destination key'),
  ).toHaveValue('customer');
  await expect(
    restored.getByRole('listitem').nth(0).getByLabel('Output path'),
  ).toHaveValue('$.customer');
  const restoredLiteral = await restored
    .getByRole('listitem')
    .nth(2)
    .getByLabel('JSON value')
    .inputValue();
  expect(JSON.parse(restoredLiteral)).toEqual(
    JSON.parse('{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}'),
  );
});

test('cross-tab sign-out pauses a dirty editor without exposing its scratch to the new session', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: mappingGraph(),
    revision: 1,
    etagIndex: 0,
  };
  const second = await context.newPage();
  let authenticated = true;
  await addCsrfCookie(context);
  for (const tab of [page, second]) {
    await installEditorRoutes(tab, remote, workspace, [
      manualDefinition,
      definition,
    ]);
    await tab.route('**/v1/users/me', async (route) => {
      if (authenticated) await route.fulfill({ json: user });
      else
        await route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'urn:pertexo:problem:auth.unauthenticated',
            title: 'Authentication required',
            status: 401,
            code: 'auth.unauthenticated',
            requestId: 'cross-tab-auth-loss',
          }),
        });
    });
  }
  await second.route('**/v1/auth/logout', async (route) => {
    authenticated = false;
    await route.fulfill({ status: 204 });
  });

  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await page.getByTestId('rf__node-target').click();
  await page.getByLabel('Value').fill('private unfinished work');
  await second.goto('/workspaces');
  await second.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Editor paused' }),
  ).toBeVisible();
  await expect(page.getByText('private unfinished work')).toBeHidden();
  expect(remote.revision).toBe(1);
  authenticated = true;
  await page.getByRole('button', { name: 'Verify original account' }).click();
  await expect(page.getByLabel('Value')).toHaveValue('private unfinished work');
  await second.close();
});

test('edits, autosaves, and preserves both drafts during a two-tab conflict', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  const second = await context.newPage();
  await installEditorRoutes(page, remote);
  await installEditorRoutes(second, remote);
  const url = `/w/${workspaceId}/workflows/${workflowId}`;
  await Promise.all([page.goto(url), second.goto(url)]);
  await page.getByRole('button', { name: /core\.set/u }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect
    .poll(() => remote.graph.nodes.length, { timeout: 4_000 })
    .toBe(1);
  await expect(page.getByText('Saved')).toBeVisible();
  expect(remote.graph.nodes).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);

  await second.getByRole('button', { name: /core\.set/u }).click();
  await expect(second.getByText('Unsaved changes')).toBeVisible();
  await expect(
    second.getByRole('heading', { name: 'This draft changed elsewhere' }),
  ).toBeVisible({ timeout: 4_000 });
  await expect(second.getByText('1 nodes, 0 edges')).toHaveCount(2);
  await second.getByRole('button', { name: 'Keep local for review' }).click();
  await expect(
    second.getByRole('region', { name: 'Retained local conflict comparison' }),
  ).toBeVisible();
  await expect(second.getByText('Saved')).toBeVisible();
  expect(remote.graph.nodes).toHaveLength(1);
  expect(remote.revision).toBe(2);

  await second.getByRole('button', { name: /core\.set/u }).click();
  await expect(second.getByText('Unsaved changes')).toBeVisible();
  await expect(second.getByText('Saved')).toBeVisible();
  await expect.poll(() => remote.graph.nodes.length).toBe(2);
  expect(remote.revision).toBe(3);
  await expect(
    second.getByRole('region', { name: 'Retained local conflict comparison' }),
  ).toBeVisible();
  expect(
    await second.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await second.getByRole('button', { name: 'Settings' }).click();
  await expect(
    second.getByRole('heading', { name: 'Discard the retained comparison?' }),
  ).toBeVisible();
  await expect(second).toHaveURL(url);
  await second.getByRole('button', { name: 'Stay here' }).click();
  await second.getByRole('button', { name: 'Dismiss comparison' }).click();
  await expect(
    second.getByRole('region', { name: 'Retained local conflict comparison' }),
  ).toBeHidden();
  expect(
    await second.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await second.getByRole('button', { name: 'Back' }).click();
  await expect(second).toHaveURL(`/w/${workspaceId}/workflows`);
});

test('keeps keyboard placement usable and the narrow editor horizontally bounded', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  const panelNavigation = page.getByRole('navigation', {
    name: 'Workflow editor panels',
  });
  await expect(panelNavigation).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Workflow canvas' }),
  ).toBeVisible();
  const nodesPanel = panelNavigation.getByRole('button', { name: 'Nodes' });
  await nodesPanel.focus();
  await page.keyboard.press('Enter');
  const add = page.getByRole('button', { name: /core\.set/u });
  await expect(add).toBeVisible();
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 4_000 });
  await panelNavigation.getByRole('button', { name: 'Canvas' }).click();
  const canvas = page.getByRole('region', { name: 'Workflow canvas' });
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width).toBeGreaterThan(360);
  expect(canvasBox?.height).toBeGreaterThan(500);
  await page.locator('.react-flow__node').click();
  await panelNavigation.getByRole('button', { name: 'Inspector' }).click();
  await page.getByLabel('Label').fill('Mobile scratch');
  await panelNavigation.getByRole('button', { name: 'Canvas' }).click();
  await panelNavigation.getByRole('button', { name: 'Inspector' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Mobile scratch');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('keeps workflow identity and metadata recovery available at 320 and 390 pixels', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    revision: 1,
    etagIndex: 0,
  };
  let metadataAvailable = false;
  const longName = 'W'.repeat(128);
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      metadataAvailable
        ? route.fulfill({
            json: {
              workflow: {
                id: workflowId,
                workspaceId,
                name: longName,
                lifecycleStatus: 'active',
                lifecycleRevision: 1,
                activationStatus: 'inactive',
                publishedVersionId: null,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
              },
            },
          })
        : route.fulfill({ status: 500, json: {} }),
  );

  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await expect(
    page.getByRole('heading', { name: 'Workflow name unavailable' }),
  ).toBeVisible();
  await expect(page.getByText(workflowId, { exact: true })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry name' });
  await expect(retry).toBeVisible();

  metadataAvailable = true;
  await retry.click();
  await expect(page.getByRole('heading', { name: longName })).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const identity = page.getByRole('heading', { name: longName });
    const box = await identity.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    const canvas = page.getByRole('region', { name: 'Workflow canvas' });
    await expect(canvas).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(width - 30);
    expect(canvasBox?.height).toBeGreaterThan(400);
  }
});

test('confirms dirty-editor logout before revoking the session', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: {
      schemaVersion: 1,
      nodes: [editorNode('node-a', 'Original label', 'value', 80)],
      edges: [],
      settings: {},
    },
    revision: 1,
    etagIndex: 0,
  };
  let logoutRequests = 0;
  let signedOut = false;
  let discoveryUnavailable = false;
  let releaseSave: (() => void) | undefined;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route('**/v1/users/me', (route) =>
    signedOut
      ? route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://pertexo.test/problems/auth.unauthenticated',
            title: 'Authentication required',
            status: 401,
            code: 'auth.unauthenticated',
            requestId: 'request-logout-ordering',
          }),
        })
      : discoveryUnavailable
        ? route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'urn:pertexo:problem:service.unavailable',
              title: 'Service unavailable',
              status: 503,
              code: 'service.unavailable',
              requestId: 'request-user-discovery-unavailable',
            }),
          })
        : route.fulfill({ json: user }),
  );
  await page.route('**/v1/auth/logout', async (route) => {
    logoutRequests += 1;
    signedOut = true;
    await route.fulfill({ status: 204 });
  });
  await page.route('**/v1/workspaces?**', async (route) => {
    if (!discoveryUnavailable) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:pertexo:problem:service.unavailable',
        title: 'Service unavailable',
        status: 503,
        code: 'service.unavailable',
        requestId: 'request-workspace-discovery-unavailable',
      }),
    });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      await saveGate;
      await route.fallback();
    },
  );

  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await page.getByTestId('rf__node-node-a').click();
  await page.getByLabel('Label').fill('Unapplied logout scratch');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Leave with unapplied changes?' }),
  ).toBeVisible();
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: 'Stay here' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Close navigation' })
    .click();
  await expect(page.getByLabel('Label')).toHaveValue(
    'Unapplied logout scratch',
  );
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows/${workflowId}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  await drawer.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Leave with unapplied changes?' }),
  ).toBeVisible();
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: 'Stay here' }).click();
  await drawer.getByRole('button', { name: 'Close navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Workflow editor panels' })
    .getByRole('button', { name: 'Inspector' })
    .click();
  await expect(page.getByLabel('Label')).toHaveValue(
    'Unapplied logout scratch',
  );

  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Leave with unapplied changes?' }),
  ).toBeVisible();
  expect(logoutRequests).toBe(0);
  discoveryUnavailable = true;
  await page.getByRole('button', { name: 'Leave editor' }).click();
  await expect.poll(() => logoutRequests).toBe(1);
  await expect(page).toHaveURL(/\/login$/u);
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  releaseSave?.();
});

test('keeps editable canvas and canvas-local toolbar usable across responsive layouts', async ({
  context,
  page,
}, testInfo) => {
  const remote: RemoteDraft = {
    graph: {
      schemaVersion: 1,
      nodes: [editorNode('node-a', 'Selected node', 'value', 80)],
      edges: [],
      settings: {},
    },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  const longWorkflowName =
    'Customer onboarding and account provisioning across regional operations';
  await installEditorRoutes(
    page,
    remote,
    workspace,
    [definition],
    longWorkflowName,
  );
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await expect(
    page.getByRole('navigation', { name: 'Workspace navigation' }),
  ).toHaveCount(0);

  for (const width of [390, 720, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const panelNavigation = page.getByRole('navigation', {
      name: 'Workflow editor panels',
    });
    if (width < 1280) {
      await expect(panelNavigation).toBeVisible();
      await panelNavigation.getByRole('button', { name: 'Canvas' }).click();
    } else {
      await expect(panelNavigation).toBeHidden();
    }
    const canvas = page.getByRole('region', { name: 'Workflow canvas' });
    const commandBar = page.getByLabel('Workflow editor commands');
    const commandBarBox = await commandBar.boundingBox();
    if (width === 1440) expect(commandBarBox?.height).toBeLessThanOrEqual(64);
    if (width === 390) expect(commandBarBox?.height).toBeLessThanOrEqual(160);
    await expect(
      commandBar.getByRole('heading', { name: longWorkflowName }),
    ).toHaveAttribute('title', longWorkflowName);
    await expect(
      commandBar.getByRole('button', { name: 'Open navigation' }),
    ).toBeVisible();
    await expect(canvas).toBeVisible();
    await page.getByTestId('rf__node-node-a').click();
    const toolbar = page.getByRole('toolbar', { name: 'Canvas selection' });
    await expect(toolbar).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    const toolbarBox = await toolbar.boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(
      width === 390
        ? 350
        : width === 720
          ? 680
          : width === 1024
            ? 990
            : width === 1280
              ? 680
              : 830,
    );
    expect(toolbarBox?.x).toBeGreaterThanOrEqual(canvasBox?.x ?? 0);
    expect((toolbarBox?.x ?? 0) + (toolbarBox?.width ?? 0)).toBeLessThanOrEqual(
      (canvasBox?.x ?? 0) + (canvasBox?.width ?? 0),
    );
    const minimapBox = await canvas
      .locator('.react-flow__minimap')
      .boundingBox();
    const controlsBox = await canvas
      .locator('.react-flow__controls')
      .boundingBox();
    expect(
      (toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0),
    ).toBeLessThanOrEqual(
      Math.min(
        minimapBox?.y ?? Number.POSITIVE_INFINITY,
        controlsBox?.y ?? Number.POSITIVE_INFINITY,
      ),
    );
    if (width === 390) expect(minimapBox).toBeNull();
    else await expect(canvas.locator('.react-flow__minimap')).toBeVisible();
    const firstControl = canvas
      .locator('.react-flow__controls-button:not(:disabled)')
      .first();
    const controlColors = await firstControl.evaluate((element) => {
      const buttonStyle = getComputedStyle(element);
      const icon = element.querySelector('svg');
      return {
        background: buttonStyle.backgroundColor,
        icon: icon === null ? '' : getComputedStyle(icon).fill,
      };
    });
    expect(controlColors.background).not.toBe('rgb(254, 254, 254)');
    expect(controlColors.icon).not.toBe(controlColors.background);
    await firstControl.focus();
    const controlFocus = await firstControl.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        active: document.activeElement === element,
        outline: style.outlineStyle,
        shadow: style.boxShadow,
      };
    });
    expect(controlFocus.active).toBe(true);
    expect(
      controlFocus.outline !== 'none' || controlFocus.shadow !== 'none',
    ).toBe(true);
    const inspector = page.getByRole('region', { name: 'Node inspector' });
    if (width >= 1280) {
      const inspectorBox = await inspector.boundingBox();
      expect(
        (toolbarBox?.x ?? 0) + (toolbarBox?.width ?? 0),
      ).toBeLessThanOrEqual(inspectorBox?.x ?? Number.POSITIVE_INFINITY);
    }
    if (width === 390 || width === 720 || width === 1440) {
      const evidenceName =
        width === 720
          ? 'editor-200-percent-equivalent'
          : `editor-${String(width)}`;
      const screenshot = await page.screenshot({ fullPage: true });
      await testInfo.attach(evidenceName, {
        body: screenshot,
        contentType: 'image/png',
      });
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/${evidenceName}.png`,
          fullPage: true,
        });
    }
  }

  await page.emulateMedia({ forcedColors: 'active' });
  const navigationTrigger = page.getByRole('button', {
    name: 'Open navigation',
  });
  await page.getByRole('button', { name: 'Settings' }).focus();
  await page.keyboard.press('Tab');
  await expect(navigationTrigger).toBeFocused();
  const forcedFocus = await navigationTrigger.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      active: document.activeElement === element,
      outline: style.outlineStyle,
      shadow: style.boxShadow,
    };
  });
  expect(forcedFocus.active).toBe(true);
  expect(forcedFocus.outline !== 'none' || forcedFocus.shadow !== 'none').toBe(
    true,
  );
  await testInfo.attach('editor-forced-colors', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
    await page.screenshot({
      path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/editor-forced-colors.png`,
      fullPage: true,
    });
});

test('gives a read-only actor the flexible canvas column without moving the inspector', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: {
      schemaVersion: 1,
      nodes: [
        {
          ...editorNode('node-a', 'Read-only node', 'value', 80),
          inputMappings: {
            customer: { kind: 'literal', value: { retained: true } },
          },
        },
      ],
      edges: [],
      settings: {},
    },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    ...workspace,
    role: 'viewer',
    capabilities: ['workspace:read', 'workflow:read', 'connection:read'],
  });
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);

  await expect(
    page.getByRole('complementary', { name: 'Node palette' }),
  ).toHaveCount(0);
  for (const width of [390, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const panelNavigation = page.getByRole('navigation', {
      name: 'Workflow editor panels',
    });
    if (width < 1280) {
      await expect(panelNavigation).toBeVisible();
      await panelNavigation.getByRole('button', { name: 'Canvas' }).click();
    } else {
      await expect(panelNavigation).toBeHidden();
    }
    const canvas = page.getByRole('region', { name: 'Workflow canvas' });
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(width === 390 ? 350 : 500);
    if (width >= 1280) {
      const inspector = page.getByRole('region', { name: 'Node inspector' });
      const inspectorBox = await inspector.boundingBox();
      expect(inspectorBox?.x).toBeGreaterThan(
        (canvasBox?.x ?? 0) + (canvasBox?.width ?? 0) - 1,
      );
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  }
  await page.getByTestId('rf__node-node-a').click();
  const inputs = page.getByRole('region', { name: 'Inputs' });
  await expect(inputs.getByRole('button', { name: 'Add input' })).toHaveCount(
    0,
  );
  await expect(inputs.getByLabel('Destination key')).toBeDisabled();
  await expect(inputs.getByLabel('JSON value')).toBeDisabled();
});

test('guards unapplied inspector fields and applies the supported schema controls', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: {
      schemaVersion: 1,
      nodes: [
        {
          id: 'node-a',
          definition: { key: 'core.set', version: 1 },
          position: { x: 80, y: 80 },
          configVersion: 1,
          config: { count: 7, legacy: { preserved: true } },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await page.locator('.react-flow__node').click();
  await page.getByLabel('Value').fill('reviewed');
  await page.getByLabel('Label').fill('Configured set');
  const count = page.getByLabel('Count');
  await expect(count).toHaveValue('7');
  await count.fill('');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'Workflows' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Leave with unapplied changes?' }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows/${workflowId}`);
  await page.getByRole('button', { name: 'Stay here' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Close navigation' })
    .click();
  await count.fill('-');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByText('Count must be a valid number.')).toBeVisible();
  await expect(count).toBeFocused();
  expect(remote.revision).toBe(1);
  await count.fill('0');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);
  await expect(page.getByText('Saved')).toBeVisible();
  expect(remote.graph.nodes[0]).toMatchObject({
    config: { value: 'reviewed', count: 0, legacy: { preserved: true } },
  });

  await count.fill('-2.5');
  await page.getByRole('button', { name: 'Cancel changes' }).click();
  await expect(count).toHaveValue('0');
  expect(remote.revision).toBe(2);
  await count.fill('-2.5');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(3);
  expect(remote.graph.nodes[0]).toMatchObject({
    config: { value: 'reviewed', count: -2.5, legacy: { preserved: true } },
  });
  await count.fill('');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(4);
  expect(remote.graph.nodes[0]).toMatchObject({
    config: { value: 'reviewed', legacy: { preserved: true } },
  });
});

test('resolves dirty node switches and keeps inspector history consistent', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: {
      schemaVersion: 1,
      nodes: [
        editorNode('node-a', 'Node A', 'A', 80),
        editorNode('node-b', 'Node B', 'B', 380),
      ],
      edges: [],
      settings: {},
    },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);

  await page.getByTestId('rf__node-node-a').click();
  await expect(
    page.getByRole('toolbar', { name: 'Canvas selection' }),
  ).toContainText('1 node selected');
  await page.getByLabel('Label').fill('Scratch A');
  await page.getByTestId('rf__node-node-b').click();
  await expect(
    page.getByRole('heading', { name: 'Resolve unapplied changes' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Scratch A');

  await page.getByTestId('rf__node-node-b').click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Node B');
  expect(remote.revision).toBe(1);

  await page.getByLabel('Label').fill('Applied B');
  await page.getByTestId('rf__node-node-a').click();
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Node A');
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);

  await page.getByTestId('rf__node-node-b').click();
  await expect(page.getByLabel('Label')).toHaveValue('Applied B');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Node B');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Applied B');

  await page.getByLabel('Label').fill('Scratch history edit');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resolve unapplied changes' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Scratch history edit');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Node B');
});

test('guards canvas-scoped keyboard deletion when inspector edits are unapplied', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: {
      schemaVersion: 1,
      nodes: [editorNode('node-a', 'Node A', 'A', 80)],
      edges: [],
      settings: {},
    },
    revision: 1,
    etagIndex: 0,
  };
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await page.getByTestId('rf__node-node-a').click();
  await page.getByLabel('Label').fill('Scratch label');

  await page.getByRole('button', { name: 'Save now' }).focus();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('rf__node-node-a')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Resolve unapplied changes' }),
  ).not.toBeVisible();

  await page.getByTestId('rf__node-node-a').click();
  await page.keyboard.press('Delete');
  await expect(
    page.getByRole('heading', { name: 'Resolve unapplied changes' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Label')).toHaveValue('Scratch label');

  await page.getByTestId('rf__node-node-a').click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByTestId('rf__node-node-a')).not.toBeVisible();
});

test('validates, previews, publishes, and follows the exact accepted run version', async ({
  context,
  page,
}) => {
  const remote: RemoteDraft = {
    graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    revision: 1,
    etagIndex: 0,
  };
  const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const previewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
    (route) =>
      route.fulfill({
        json: {
          valid: true,
          issues: [],
          compatibility: draftBody(remote).compatibility,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/nodes/*/test`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        mode: 'validate' | 'test_execute';
        expectedRevision: number;
      };
      expect(body.expectedRevision).toBe(remote.revision);
      const nodeId = String(
        remote.graph.nodes.length > 0
          ? Reflect.get(remote.graph.nodes[0] as object, 'id')
          : 'missing',
      );
      const disclosure = {
        sideEffectClass: 'safe',
        mayContactProvider: false,
        mayCauseExternalSideEffect: false,
        dryRun: 'not_supported',
      };
      if (body.mode === 'validate') {
        await route.fulfill({
          json: {
            mode: 'validate',
            valid: true,
            revision: remote.revision,
            nodeId,
            issues: [],
            disclosure,
          },
        });
        return;
      }
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      await route.fulfill({
        status: 202,
        json: {
          mode: 'test_execute',
          replayed: false,
          preview: previewSummary(
            previewId,
            nodeId,
            remote.revision,
            disclosure,
          ),
        },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
    (route) => {
      expect(route.request().headers()['if-match']).toBe(currentEtag(remote));
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({
        json: {
          version: {
            id: versionId,
            workflowId,
            versionNumber: 1,
            schemaVersion: 1,
            graph: remote.graph,
            checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
            publishedAt: '2026-09-14T10:02:00.000Z',
          },
          reused: false,
        },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
    (route) => {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({
        json: { run: runSummary(runId, versionId, 'queued'), replayed: false },
      });
    },
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs/${runId}`, (route) =>
    route.fulfill({
      json: { run: runSummary(runId, versionId, 'succeeded'), nodes: [] },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: versionId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph: remote.graph,
              checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
              publishedAt: '2026-09-14T10:02:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${runId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\nevent: run.succeeded\ndata: ${JSON.stringify({
          sequence: 1,
          type: 'run.succeeded',
          createdAt: '2026-09-14T10:03:00.000Z',
          payload: { schemaVersion: 1 },
        })}\n\n`,
      }),
  );

  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await page.getByRole('button', { name: /core\.set/u }).click();
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);
  await page.locator('.react-flow__node').click();
  await page.getByRole('button', { name: 'Preview node' }).click();
  await page.getByRole('button', { name: 'Validate node' }).click();
  await expect(page.getByText('Node valid')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Test execute' }).click();
  await expect(page.getByText('Preview status:')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.getByText('Validation: valid')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Publish version' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.getByRole('button', { name: 'Start published version' }).click();

  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${runId}`);
  await expect(page.getByText(versionId)).toBeVisible();
  await expect(page.getByText('Events: stopped')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Execution map' }),
  ).toBeVisible();
});

test('animates active execution flow and disables the marker for reduced motion', async ({
  page,
}) => {
  const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'source-node',
        definition: { key: 'core.source', version: 1 },
        position: { x: 80, y: 120 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target-node',
        definition: { key: 'core.target', version: 1 },
        position: { x: 420, y: 120 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'source-to-target',
        source: { nodeId: 'source-node', port: 'out' },
        target: { nodeId: 'target-node', port: 'in' },
      },
    ],
    settings: {},
  };
  const runningRun = {
    ...runSummary(runId, versionId, 'running'),
    completedAt: null,
  };
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [workspace], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs/${runId}`, (route) =>
    route.fulfill({
      json: {
        run: runningRun,
        nodes: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            nodeId: 'target-node',
            invocationKey: 'target-node:1',
            status: 'running',
            currentAttemptNumber: 1,
            startedAt: '2026-09-14T10:02:02.000Z',
            completedAt: null,
            resumeAt: null,
            safeErrorCode: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: versionId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph,
              checksum: `wf:v1:sha256:${'c'.repeat(64)}`,
              publishedAt: '2026-09-14T10:02:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${runId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\nevent: node.started\ndata: ${JSON.stringify({
          sequence: 1,
          type: 'node.started',
          createdAt: '2026-09-14T10:02:02.000Z',
          payload: {
            schemaVersion: 1,
            nodeId: 'target-node',
            invocationKey: 'target-node:1',
          },
        })}\n\n`,
      }),
  );

  await page.goto(`/w/${workspaceId}/runs/${runId}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  const marker = page.locator('.workflow-transfer-marker');
  await expect(marker).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(marker).toBeHidden();
});

function draftBody(remote: RemoteDraft) {
  return {
    workflowId,
    revision: remote.revision,
    schemaVersion: 1,
    graph: remote.graph,
    compatibility: {
      compatible: true,
      fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
      issues: [],
    },
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

function editorNode(id: string, label: string, value: string, x: number) {
  return {
    id,
    label,
    definition: { key: 'core.set', version: 1 },
    position: { x, y: 80 },
    configVersion: 1,
    config: { value },
    inputMappings: {},
    connectionRefs: {},
  };
}

function mappingGraph(): Graph {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'manual',
        label: 'Manual input',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target',
        label: 'Target',
        definition: { key: 'core.set', version: 1 },
        position: { x: 380, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
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

function parseGraphRequest(value: string | null): { graph: Graph } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || !('graph' in parsed))
      return null;
    const graph = Reflect.get(parsed, 'graph');
    if (!isGraph(graph)) return null;
    return { graph };
  } catch {
    return null;
  }
}

function isGraph(value: unknown): value is Graph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'nodes')) &&
    Array.isArray(Reflect.get(value, 'edges'))
  );
}

async function addCsrfCookie(context: BrowserContext) {
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
}

function currentEtag(remote: RemoteDraft): string {
  return etags[remote.etagIndex] ?? etags[0];
}

function runSummary(
  runId: string,
  versionId: string,
  status: 'queued' | 'running' | 'succeeded',
) {
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
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

function previewSummary(
  previewId: string,
  nodeId: string,
  revision: number,
  disclosure: Readonly<Record<string, unknown>>,
) {
  return {
    id: previewId,
    workspaceId,
    workflowId,
    draftRevision: revision,
    nodeId,
    status: 'succeeded',
    disclosure,
    output: { kind: 'inline', value: { accepted: true } },
    safeErrorCode: null,
    createdAt: '2026-09-14T10:01:00.000Z',
    startedAt: '2026-09-14T10:01:01.000Z',
    completedAt: '2026-09-14T10:01:02.000Z',
    expiresAt: '2026-09-14T11:01:02.000Z',
  };
}
