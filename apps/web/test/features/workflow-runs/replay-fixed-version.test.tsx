import type { AccessibleWorkspace } from '@pertexo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureRun,
  identityHandlers,
  sseEvents,
  statisticsHandler,
} from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const { workspace: workspaceId, firstRun: sourceRunId } = fixtureIds;
const { workflow: workflowId, version: sourceVersionId } = fixtureIds;
const fixedVersionId = '99999999-9999-4999-8999-999999999999';
const workflowApi = `${apiBase}/workflows/${workflowId}`;
const operator: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'run:replay',
  'workflow:read',
];

const version = (id: string, versionNumber: number) => ({
  id,
  workflowId,
  versionNumber,
  graph: { nodes: [], edges: [], settings: {} },
  checksum: `wf:sha256:${'b'.repeat(64)}`,
  publishedAt: '2026-09-14T10:02:00.000Z',
});

function install(latest: { id: string; versionNumber: number }) {
  const versions = [
    version(sourceVersionId, 2),
    ...(latest.id === sourceVersionId
      ? []
      : [version(latest.id, latest.versionNumber)]),
  ];
  mockServer.use(
    ...identityHandlers(operator),
    statisticsHandler(),
    http.get(`${apiBase}/runs/:runId/input`, () =>
      HttpResponse.json({
        input: { kind: 'inline', value: { order: 'A-17' } },
      }),
    ),
    http.get(`${apiBase}/runs/:runId/recovery`, () =>
      HttpResponse.json({
        kind: 'eligible',
        workflowVersionId: sourceVersionId,
        versionNumber: 2,
        nodeRunId: sourceRunId,
        nodeId: 'http',
        nodeLabel: 'Send request',
        reusedCount: 1,
        sourceCompletedAt: '2026-10-13T00:00:00.000Z',
        effectRisk: 'ordinary',
      }),
    ),
    http.get(`${apiBase}/runs/:runId`, ({ params }) =>
      HttpResponse.json({
        run: fixtureRun(String(params.runId), 'failed'),
        nodes: [],
      }),
    ),
    http.get(
      `${apiBase}/runs/:runId/events`,
      () =>
        new HttpResponse(sseEvents([{ type: 'run.failed' }]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(workflowApi, () =>
      HttpResponse.json({
        workflow: {
          id: workflowId,
          workspaceId,
          name: 'Customer onboarding',
          nameRevision: 1,
          lifecycleStatus: 'active',
          lifecycleRevision: 1,
          activationStatus: 'active',
          webhookSetupRequired: false,
          publishedVersionId: latest.id,
          createdAt: '2026-09-14T10:02:00.000Z',
          updatedAt: '2026-09-14T10:02:00.000Z',
        },
      }),
    ),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({ items: [...versions].reverse(), nextCursor: null }),
    ),
    http.get(`${workflowApi}/versions/:versionId`, ({ params }) =>
      HttpResponse.json(
        versions.find(({ id }) => id === params.versionId) ?? versions[0],
      ),
    ),
  );
}

async function openReplay() {
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Replay' }, coldStart),
  );
  return {
    event,
    dialog: await screen.findByRole('dialog', { name: 'Replay this run' }),
  };
}

function captureReplay() {
  const bodies: { workflowVersionId?: string }[] = [];
  mockServer.use(
    http.post(`${apiBase}/runs/${sourceRunId}/replay`, async ({ request }) => {
      bodies.push((await request.json()) as { workflowVersionId?: string });
      const { workflowName: _name, ...run } = fixtureRun(
        fixtureIds.replayRun,
        'queued',
      );
      return HttpResponse.json({ run, replayed: false }, { status: 202 });
    }),
  );
  return bodies;
}

describe('replaying a failed run after a fix is published', () => {
  // product-ux-04: the dialog pins the failed version, so following its advice repeats the failure.
  it.fails('offers the fixed version and starts on it by default', async () => {
    install({ id: fixedVersionId, versionNumber: 3 });
    const bodies = captureReplay();
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const { dialog, event } = await openReplay();
    const fixed = await within(dialog).findByRole('radio', { name: /v3/u });
    expect(fixed).toBeChecked();
    expect(
      within(dialog).getByRole('radio', { name: /v2/u }),
    ).not.toBeChecked();
    await event.click(
      within(dialog).getByRole('button', { name: 'Replay run' }),
    );
    await expect
      .poll(() => bodies.map((body) => body.workflowVersionId))
      .toEqual([fixedVersionId]);
  });

  // product-ux-04: the choice has to keep the original available too.
  it.fails('can still replay the version the run used', async () => {
    install({ id: fixedVersionId, versionNumber: 3 });
    const bodies = captureReplay();
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const { dialog, event } = await openReplay();
    await event.click(
      await within(dialog).findByRole('radio', { name: /v2/u }),
    );
    await event.click(
      within(dialog).getByRole('button', { name: 'Replay run' }),
    );
    await expect
      .poll(() => bodies.map((body) => body.workflowVersionId))
      .toEqual([sourceVersionId]);
  });

  it('offers no choice when the run already used the latest version', async () => {
    install({ id: sourceVersionId, versionNumber: 2 });
    const bodies = captureReplay();
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const { dialog, event } = await openReplay();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await event.click(
      within(dialog).getByRole('button', { name: 'Replay run' }),
    );
    await expect
      .poll(() => bodies.map((body) => body.workflowVersionId))
      .toEqual([sourceVersionId]);
  });

  // product-ux-04: a recovery run stays on its version (CONTEXT.md), so the dialog must point at the fix.
  it.fails(
    'points from Retry from this step to replaying on the fixed version',
    async () => {
      install({ id: fixedVersionId, versionNumber: 3 });
      renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
      const event = userEvent.setup();
      await event.click(
        await screen.findByRole(
          'button',
          { name: 'Retry from this step' },
          coldStart,
        ),
      );
      const dialog = await screen.findByRole('dialog', {
        name: 'Retry from this step',
      });
      expect(dialog).toHaveTextContent('v2');
      await event.click(
        await within(dialog).findByRole('button', { name: /Replay.*v3/u }),
      );
      const replay = await screen.findByRole('dialog', {
        name: 'Replay this run',
      });
      expect(
        await within(replay).findByRole('radio', { name: /v3/u }),
      ).toBeChecked();
    },
  );
});
