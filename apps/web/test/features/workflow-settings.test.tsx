import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { workflowKeys } from '@/features/workflows/public';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const secondWorkflowId = '99999999-9999-4999-8999-999999999999';
const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const scheduleId = '11111111-1111-4111-8111-111111111111';
const webhookId = '22222222-2222-4222-8222-222222222222';
const secondWebhookId = '55555555-5555-4555-8555-555555555555';
const destinationId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const etag = `"draft-v1.${'a'.repeat(43)}"`;
const etagB = `"draft-v1.${'b'.repeat(43)}"`;
const etagC = `"draft-v1.${'c'.repeat(43)}"`;
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
    'connection:manage',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const graph = { schemaVersion: 1, nodes: [], edges: [], settings: {} };
const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
  issues: [],
};
const summary = {
  id: workflowId,
  workspaceId,
  name: 'Daily control',
  lifecycleStatus: 'active',
  lifecycleRevision: 7,
  activationStatus: 'active',
  publishedVersionId: versionId,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const schedule = {
  id: scheduleId,
  workflowId,
  workflowVersionId: versionId,
  nodeId: 'schedule-node',
  kind: 'schedule',
  status: 'active',
  healthStatus: 'healthy',
  lastErrorCode: null,
  reconciledAt: '2026-09-14T10:00:00.000Z',
  recurrence: { kind: 'interval', intervalMinutes: 15 },
  misfirePolicy: 'skip',
  nextFireAt: '2026-09-14T10:15:00.000Z',
  lastFireAt: null,
};
const webhook = {
  id: webhookId,
  workflowId,
  workflowVersionId: versionId,
  nodeId: 'webhook-node',
  kind: 'webhook',
  status: 'configuration_required',
  healthStatus: 'pending',
  lastErrorCode: null,
  endpointReady: false,
  reconciledAt: null,
};
const secondWebhook = {
  ...webhook,
  id: secondWebhookId,
  nodeId: 'webhook-node-two',
};
const destination = {
  id: destinationId,
  workspaceId,
  kind: 'email',
  status: 'enabled',
  currentVersion: 1,
  config: { kind: 'email', connectionId, toEmail: 'alerts@example.test' },
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

function installQueries() {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/workflows`, () =>
      HttpResponse.json({ items: [summary], nextCursor: null }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
      () =>
        HttpResponse.json({
          items: [
            {
              id: versionId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph,
              checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
              publishedAt: '2026-09-14T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/schedules`,
      () => HttpResponse.json({ items: [schedule] }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`,
      () => HttpResponse.json({ items: [webhook] }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      () => HttpResponse.json({ items: [destination] }),
    ),
  );
}

describe('workflow settings route', () => {
  it('refreshes cached Overview workflows immediately after an archive', async () => {
    let currentSummary = summary;
    let recentReads = 0;
    installQueries();
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        ({ request }) => {
          if (new URL(request.url).searchParams.get('order') === 'updated_desc')
            recentReads += 1;
          return HttpResponse.json({
            items: [currentSummary],
            nextCursor: null,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/archive`,
        () => {
          currentSummary = {
            ...summary,
            lifecycleStatus: 'archived',
            lifecycleRevision: 8,
          };
          return HttpResponse.json({
            workflow: currentSummary,
            replayed: false,
          });
        },
      ),
    );
    const { queryClient, router } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    queryClient.setQueryData(workflowKeys.recent(userId, workspaceId), {
      items: [summary],
      nextCursor: null,
    });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    await event.click(screen.getByRole('button', { name: /^Archive$/u }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Archive workflow?' }),
      ).not.toBeInTheDocument();
    });
    await router.navigate({
      to: '/w/$workspaceId/overview',
      params: { workspaceId },
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Recently managed workflows',
      }),
    ).toBeVisible();
    expect(screen.getByText('archived')).toBeVisible();
    expect(recentReads).toBe(1);
  });

  it('keeps exact lifecycle, trigger, secret and notification command contracts', async () => {
    const keys: string[] = [];
    installQueries();
    mockServer.use(
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/archive`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          await expect(request.json()).resolves.toEqual({
            expectedLifecycleRevision: 7,
          });
          return HttpResponse.json({
            workflow: {
              ...summary,
              lifecycleStatus: 'archived',
              lifecycleRevision: 8,
            },
            replayed: false,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${scheduleId}/schedule/disable`,
        ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          return HttpResponse.json({
            trigger: {
              ...schedule,
              status: 'disabled',
              healthStatus: 'disabled',
            },
            replayed: false,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${webhookId}/webhook/provision`,
        ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'e'.repeat(43),
            signingSecret: 's'.repeat(43),
          });
        },
      ),
      http.put(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/failure-notification-policy`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          await expect(request.json()).resolves.toEqual({ destinationId });
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const event = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'Workflow settings' }),
    ).toBeVisible();

    const settingsNavigation = screen.getByRole('navigation', {
      name: 'Workflow settings sections',
    });
    expect(
      within(settingsNavigation).getByRole('link', { name: 'Lifecycle' }),
    ).toHaveAttribute('href', '#workflow-lifecycle');
    const notificationsSection = screen
      .getByRole('heading', { name: 'Failure notifications' })
      .closest('section');
    const lifecycleSection = screen
      .getByRole('heading', { name: 'Lifecycle' })
      .closest('section');
    if (notificationsSection === null || lifecycleSection === null)
      throw new Error('Expected workflow settings sections');
    expect(
      notificationsSection.compareDocumentPosition(lifecycleSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      within(notificationsSection).queryByRole('button', { name: 'Disable' }),
    ).not.toBeInTheDocument();
    expect(
      within(notificationsSection).getByRole('link', {
        name: 'Manage workspace destinations',
      }),
    ).toHaveAttribute('href', `/w/${workspaceId}/settings/notifications`);

    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    await event.click(screen.getByRole('button', { name: /^Archive$/u }));
    const [disableSchedule] = screen.getAllByRole('button', {
      name: /^Disable$/u,
    });
    if (disableSchedule === undefined)
      throw new Error('Expected a schedule disable action');
    await event.click(disableSchedule);
    await event.click(
      screen.getByRole('button', { name: 'Provision endpoint' }),
    );
    expect(await screen.findByText('e'.repeat(43))).toBeVisible();
    expect(screen.getByText('s'.repeat(43))).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'I stored them' }));
    expect(screen.queryByText('s'.repeat(43))).not.toBeInTheDocument();
    await event.selectOptions(
      screen.getByLabelText('Destination for workflow failures'),
      destinationId,
    );
    await event.click(screen.getByRole('button', { name: 'Set policy' }));
    expect(
      await screen.findByText('Failure notification policy updated.'),
    ).toBeVisible();
    expect(keys).toHaveLength(4);
    expect(keys.every((key) => key.length > 0)).toBe(true);
  });

  it('restores a version with a freshly read draft ETag', async () => {
    installQueries();
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
        () =>
          HttpResponse.json(
            {
              workflowId,
              revision: 3,
              schemaVersion: 1,
              graph,
              compatibility,
              updatedAt: '2026-09-14T10:00:00.000Z',
            },
            { headers: { etag } },
          ),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions/${versionId}/restore`,
        ({ request }) => {
          expect(request.headers.get('if-match')).toBe(etag);
          return HttpResponse.json(
            {
              workflowId,
              revision: 4,
              schemaVersion: 1,
              graph,
              compatibility,
              updatedAt: '2026-09-14T10:01:00.000Z',
            },
            { headers: { etag: `"draft-v1.${'b'.repeat(43)}"` } },
          );
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Restore to draft' }),
    );
    await event.click(screen.getByRole('button', { name: 'Restore draft' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('does not overwrite an intervening draft after a lost restore acknowledgement', async () => {
    installQueries();
    const originalGraph = graphWithNode('original');
    const interveningGraph = graphWithNode('another-tab');
    let currentGraph = originalGraph;
    let currentEtag = etag;
    let restoreCalls = 0;
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
        () => draftResponse(currentGraph, currentEtag),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions/${versionId}/restore`,
        ({ request }) => {
          restoreCalls += 1;
          expect(request.headers.get('if-match')).toBe(etag);
          currentGraph = interveningGraph;
          currentEtag = etagC;
          return HttpResponse.error();
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Restore to draft' }),
    );
    await event.click(screen.getByRole('button', { name: 'Restore draft' }));

    expect(
      await screen.findByText(/draft changed while this restore was pending/u),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Replace newer draft' }),
    ).toBeVisible();
    expect(restoreCalls).toBe(1);
    expect(currentGraph).toEqual(interveningGraph);
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(restoreCalls).toBe(1);
    expect(currentGraph).toEqual(interveningGraph);
  });

  it('recovers from 412 only through an explicit replacement confirmation', async () => {
    installQueries();
    let currentGraph: unknown = graphWithNode('original');
    let currentEtag = etag;
    const preconditions: string[] = [];
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
        () => draftResponse(currentGraph, currentEtag),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions/${versionId}/restore`,
        ({ request }) => {
          const precondition = request.headers.get('if-match') ?? '';
          preconditions.push(precondition);
          if (preconditions.length === 1) {
            currentGraph = graphWithNode('concurrent');
            currentEtag = etagB;
            return HttpResponse.json(
              {
                type: 'urn:pertexo:problem:workflow.revision_conflict',
                title: 'Workflow revision conflict',
                status: 412,
                code: 'workflow.revision_conflict',
                requestId: 'restore-conflict',
              },
              {
                status: 412,
                headers: { 'content-type': 'application/problem+json' },
              },
            );
          }
          expect(precondition).toBe(etagB);
          currentGraph = graph;
          currentEtag = etagC;
          return draftResponse(currentGraph, currentEtag);
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Restore to draft' }),
    );
    await event.click(screen.getByRole('button', { name: 'Restore draft' }));
    expect(
      await screen.findByRole('button', { name: 'Replace newer draft' }),
    ).toBeVisible();
    expect(preconditions).toEqual([etag]);
    await event.click(
      screen.getByRole('button', { name: 'Replace newer draft' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(preconditions).toEqual([etag, etagB]);
    expect(currentGraph).toEqual(graph);
  });

  it('serializes webhook credentials until the current result is acknowledged', async () => {
    installQueries();
    let firstCalls = 0;
    let secondCalls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`,
        () => HttpResponse.json({ items: [webhook, secondWebhook] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${webhookId}/webhook/provision`,
        async () => {
          firstCalls += 1;
          await firstPending;
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'first-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'first-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${secondWebhookId}/webhook/provision`,
        () => {
          secondCalls += 1;
          return HttpResponse.json({
            trigger: {
              ...secondWebhook,
              endpointReady: true,
              status: 'active',
            },
            replayed: false,
            endpointKey: 'second-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'second-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const event = userEvent.setup();
    const buttons = await screen.findAllByRole('button', {
      name: 'Provision endpoint',
    });
    const firstButton = buttons[0];
    const secondButton = buttons[1];
    if (!firstButton || !secondButton)
      throw new Error('Expected two webhook provision actions');

    await event.click(firstButton);
    await waitFor(() => {
      expect(firstCalls).toBe(1);
    });
    expect(secondButton).toBeDisabled();
    await event.click(secondButton);
    expect(secondCalls).toBe(0);

    releaseFirst?.();
    expect(
      await screen.findByText('first-signing-secret'.padEnd(43, 's')),
    ).toBeVisible();
    expect(
      screen.queryByText('second-signing-secret'.padEnd(43, 's')),
    ).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'I stored them' }));
    expect(
      screen.queryByText('first-signing-secret'.padEnd(43, 's')),
    ).not.toBeInTheDocument();

    const secondRow = screen.getByText('Node webhook-node-two').closest('li');
    if (!secondRow) throw new Error('Expected the second webhook row');
    await event.click(
      within(secondRow).getByRole('button', { name: 'Provision endpoint' }),
    );
    expect(
      await screen.findByText('second-signing-secret'.padEnd(43, 's')),
    ).toBeVisible();
    expect(secondCalls).toBe(1);
  });

  it('uses a fresh schedule key after an uncertain command is observed and an inverse command succeeds', async () => {
    let currentSchedule = schedule;
    const disableKeys: string[] = [];
    const enableKeys: string[] = [];
    let firstDisable = true;
    installQueries();
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/schedules`,
        () => HttpResponse.json({ items: [currentSchedule] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${scheduleId}/schedule/disable`,
        ({ request }) => {
          disableKeys.push(request.headers.get('idempotency-key') ?? '');
          currentSchedule = {
            ...schedule,
            status: 'disabled',
            healthStatus: 'disabled',
          };
          if (firstDisable) {
            firstDisable = false;
            return HttpResponse.error();
          }
          return HttpResponse.json({
            trigger: currentSchedule,
            replayed: false,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${scheduleId}/schedule/enable`,
        ({ request }) => {
          enableKeys.push(request.headers.get('idempotency-key') ?? '');
          currentSchedule = schedule;
          return HttpResponse.json({
            trigger: currentSchedule,
            replayed: false,
          });
        },
      ),
    );
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    const event = userEvent.setup();
    const schedulesSection = (
      await screen.findByRole('heading', { name: 'Schedules' })
    ).closest('section');
    if (!schedulesSection) throw new Error('Expected schedules section');
    await event.click(
      await within(schedulesSection).findByRole('button', { name: 'Disable' }),
    );
    expect(await screen.findByText(/result is uncertain/u)).toBeVisible();
    queryClient.setQueryData(
      [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'schedules',
      ],
      { items: [currentSchedule] },
    );
    await event.click(
      await within(schedulesSection).findByRole('button', { name: 'Enable' }),
    );
    await event.click(
      await within(schedulesSection).findByRole('button', { name: 'Disable' }),
    );
    await waitFor(() => {
      expect(disableKeys).toHaveLength(2);
    });
    expect(enableKeys).toHaveLength(1);
    expect(disableKeys[1]).not.toBe(disableKeys[0]);
    expect(enableKeys[0]).not.toBe(disableKeys[0]);
  });

  it('blocks a conflicting failure-policy command until the exact uncertain attempt resolves', async () => {
    installQueries();
    const setKeys: string[] = [];
    const clearKeys: string[] = [];
    mockServer.use(
      http.put(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/failure-notification-policy`,
        ({ request }) => {
          setKeys.push(request.headers.get('idempotency-key') ?? '');
          return setKeys.length === 1
            ? HttpResponse.error()
            : new HttpResponse(null, { status: 204 });
        },
      ),
      http.delete(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/failure-notification-policy`,
        ({ request }) => {
          clearKeys.push(request.headers.get('idempotency-key') ?? '');
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/settings`);
    const event = userEvent.setup();
    await event.selectOptions(
      await screen.findByLabelText('Destination for workflow failures'),
      destinationId,
    );
    await event.click(screen.getByRole('button', { name: 'Set policy' }));
    expect(await screen.findByText(/result is uncertain/u)).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Clear policy' }));
    expect(
      await screen.findByText(/Resolve the earlier uncertain command/u),
    ).toBeVisible();
    expect(clearKeys).toHaveLength(0);
    await event.click(screen.getByRole('button', { name: 'Set policy' }));
    expect(
      await screen.findByText('Failure notification policy updated.'),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Clear policy' }));
    await waitFor(() => {
      expect(clearKeys).toHaveLength(1);
    });
    expect(setKeys).toHaveLength(2);
    expect(setKeys[1]).toBe(setKeys[0]);
    expect(clearKeys[0]).not.toBe(setKeys[0]);
  });

  it('removes cached protected settings and actions after nondisclosing unavailable responses', async () => {
    installQueries();
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    expect(await screen.findByText('Node webhook-node')).toBeVisible();
    expect(screen.getByText('Version 1')).toBeVisible();
    expect(screen.getByText(/Every 15 minutes/u)).toBeVisible();
    expect(screen.getByText('alerts@example.test')).toBeVisible();
    expect(screen.getByText(summary.name)).toBeVisible();
    const unavailable = () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:resource.not_found',
          title: 'Resource not found',
          status: 404,
          code: 'resource.not_found',
          requestId: 'settings-unavailable',
        },
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      );
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        unavailable,
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
        unavailable,
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/schedules`,
        unavailable,
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`,
        unavailable,
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        unavailable,
      ),
    );
    await queryClient.refetchQueries({
      predicate: ({ queryKey }) => queryKey.includes(workspaceId),
    });
    await waitFor(() => {
      expect(screen.queryByText('Node webhook-node')).not.toBeInTheDocument();
      expect(screen.queryByText('Version 1')).not.toBeInTheDocument();
      expect(screen.queryByText(/Every 15 minutes/u)).not.toBeInTheDocument();
      expect(screen.queryByText('alerts@example.test')).not.toBeInTheDocument();
      expect(screen.queryByText(summary.name)).not.toBeInTheDocument();
    });
    expect(screen.getAllByText('This section is unavailable.')).toHaveLength(5);
    expect(
      screen.queryByRole('button', { name: 'Provision endpoint' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Restore to draft' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Archive workflow' }),
    ).not.toBeInTheDocument();
  });

  it('retains cached settings with recovery controls after a transient refresh failure', async () => {
    installQueries();
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    expect(await screen.findByText(/Every 15 minutes/u)).toBeVisible();
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/schedules`,
        () => HttpResponse.json({}, { status: 500 }),
      ),
    );
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'schedules',
      ],
    });
    expect(
      await screen.findByText(
        'The latest refresh failed. Showing previously loaded data.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Every 15 minutes/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('removes lifecycle details and an open confirmation after an authoritative unavailable refresh', async () => {
    installQueries();
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Archive workflow?' }),
    ).toBeVisible();

    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () =>
          HttpResponse.json(
            {
              type: 'urn:pertexo:problem:resource.not_found',
              title: 'Resource not found',
              status: 404,
              code: 'resource.not_found',
              requestId: 'lifecycle-unavailable',
            },
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
      ),
    );
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'summary',
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText(summary.name)).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('This section is unavailable.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Archive workflow' }),
    ).not.toBeInTheDocument();
  });

  it('keeps lifecycle details and confirmation through a transient refresh and recovers', async () => {
    installQueries();
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({}, { status: 500 }),
      ),
    );
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'summary',
      ],
    });
    expect(
      await screen.findByText(
        'The latest refresh failed. Showing previously loaded data.',
      ),
    ).toBeVisible();
    expect(screen.getByText(summary.name)).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Archive workflow?' }),
    ).toBeVisible();

    installQueries();
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'summary',
      ],
    });
    await waitFor(() => {
      expect(
        screen.queryByText(
          'The latest refresh failed. Showing previously loaded data.',
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { name: 'Archive workflow?' }),
    ).toBeVisible();
  });

  it('keeps exact provisioning recovery reachable after endpoint status refreshes', async () => {
    installQueries();
    let currentWebhook = webhook;
    const provisionKeys: string[] = [];
    let rotateRequests = 0;
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`,
        () => HttpResponse.json({ items: [currentWebhook] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${webhookId}/webhook/provision`,
        ({ request }) => {
          provisionKeys.push(request.headers.get('idempotency-key') ?? '');
          currentWebhook = {
            ...webhook,
            endpointReady: true,
            status: 'active',
            healthStatus: 'healthy',
          };
          if (provisionKeys.length === 1)
            return new HttpResponse('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          return HttpResponse.json({
            trigger: currentWebhook,
            replayed: true,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${webhookId}/webhook/rotate-endpoint`,
        () => {
          rotateRequests += 1;
          return HttpResponse.json({});
        },
      ),
    );
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Provision endpoint' }),
    );
    await waitFor(() => {
      expect(provisionKeys).toHaveLength(1);
    });
    expect(
      await screen.findByRole('button', { name: 'Retry provisioning safely' }),
    ).toBeVisible();
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'webhooks',
      ],
    });
    const rotate = await screen.findByRole('button', {
      name: 'Rotate endpoint',
    });
    expect(rotate).toBeDisabled();

    await event.click(
      screen.getByRole('button', { name: 'Retry provisioning safely' }),
    );
    await waitFor(() => {
      expect(provisionKeys).toHaveLength(2);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry provisioning safely' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'Rotate endpoint' }),
    ).toBeEnabled();
    expect(provisionKeys).toHaveLength(2);
    expect(provisionKeys[1]).toBe(provisionKeys[0]);
    expect(rotateRequests).toBe(0);
  });

  it('resets settings UI state and fences late credentials when workflow identity changes', async () => {
    installQueries();
    let releaseCredentials: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () =>
          HttpResponse.json({
            items: [summary, { ...summary, id: secondWorkflowId }],
            nextCursor: null,
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${secondWorkflowId}/versions`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${secondWorkflowId}/triggers/schedules`,
        () => HttpResponse.json({ items: [] }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${secondWorkflowId}/triggers`,
        () => HttpResponse.json({ items: [] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/${webhookId}/webhook/provision`,
        async () => {
          await blocked;
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'late-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'late-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
    );
    const { router } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Provision endpoint' }),
    );
    await router.navigate({
      to: '/w/$workspaceId/workflows/$workflowId/settings',
      params: { workspaceId, workflowId: secondWorkflowId },
    });
    releaseCredentials?.();
    expect(
      await screen.findByText('No published webhook trigger exists.'),
    ).toBeVisible();
    expect(
      screen.queryByText('late-signing-secret'.padEnd(43, 's')),
    ).not.toBeInTheDocument();
  });

  it('retains the exact lifecycle command across an uncertain retry and refreshed status', async () => {
    installQueries();
    const requests: { path: string; key: string; body: unknown }[] = [];
    let currentSummary = summary;
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({ items: [currentSummary], nextCursor: null }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/archive`,
        async ({ request }) => {
          requests.push({
            path: 'archive',
            key: request.headers.get('idempotency-key') ?? '',
            body: await request.json(),
          });
          currentSummary = {
            ...summary,
            lifecycleStatus: 'archived',
            lifecycleRevision: 8,
          };
          if (requests.length === 1) return HttpResponse.error();
          return HttpResponse.json({
            workflow: currentSummary,
            replayed: true,
          });
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/restore`,
        async ({ request }) => {
          requests.push({
            path: 'restore',
            key: request.headers.get('idempotency-key') ?? '',
            body: await request.json(),
          });
          return HttpResponse.json({
            workflow: {
              ...summary,
              lifecycleStatus: 'active',
              lifecycleRevision: 9,
            },
            replayed: false,
          });
        },
      ),
    );
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/settings`,
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    currentSummary = {
      ...summary,
      lifecycleStatus: 'archived',
      lifecycleRevision: 8,
    };
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'summary',
      ],
    });
    expect(
      screen.getByRole('heading', { name: 'Archive workflow?' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: /^Archive$/u }));
    expect(
      await screen.findByText(
        'The result is uncertain. Retry to archive this workflow with the same command key.',
      ),
    ).toBeVisible();
    await queryClient.refetchQueries({
      queryKey: [
        'identity',
        userId,
        'workspace',
        workspaceId,
        'workflow',
        workflowId,
        'settings',
        'summary',
      ],
    });
    expect(
      screen.getByRole('heading', { name: 'Archive workflow?' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry safely' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(requests.slice(0, 2).map((request) => request.path)).toEqual([
      'archive',
      'archive',
    ]);
    expect(requests[0]?.body).toEqual({ expectedLifecycleRevision: 7 });
    expect(requests[1]?.body).toEqual({ expectedLifecycleRevision: 7 });
    expect(requests[0]?.key).toBe(requests[1]?.key);

    await event.click(
      await screen.findByRole('button', { name: 'Restore workflow' }),
    );
    await event.click(screen.getByRole('button', { name: /^Restore$/u }));
    expect(requests[2]).toMatchObject({
      path: 'restore',
      body: { expectedLifecycleRevision: 8 },
    });
    expect(requests[2]?.key).not.toBe(requests[0]?.key);
  });
});

function graphWithNode(label: string) {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'node-a',
        definition: { key: 'core.set', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: { value: label },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  } as const;
}

function draftResponse(currentGraph: unknown, currentEtag: string) {
  return HttpResponse.json(
    {
      workflowId,
      revision: currentEtag === etag ? 3 : currentEtag === etagB ? 4 : 5,
      schemaVersion: 1,
      graph: currentGraph,
      compatibility,
      updatedAt: '2026-09-14T10:01:00.000Z',
    },
    { headers: { etag: currentEtag } },
  );
}
