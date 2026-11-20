import type { PollingTriggerHealth } from '@pertexo/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  installQueries,
  stepNode,
  summary,
  version,
  versionId,
  workflowApi,
} from './fixtures';
import { triggersPath } from './triggers/fixture';

const health: PollingTriggerHealth = {
  kind: 'polling',
  id: '81a30608-cbcd-43bd-a9b0-daf8314d21b7',
  workflowVersionId: versionId,
  nodeId: 'poll-feed',
  baselineEstablished: false,
  healthStatus: 'pending',
  lastErrorCode: null,
  nextPollAt: '2026-11-20T10:35:00.000Z',
  paused: false,
};

function renderPolling(trigger: PollingTriggerHealth) {
  installQueries();
  mockServer.use(
    http.get(workflowApi, () =>
      HttpResponse.json({
        workflow: { ...summary, pollingTriggers: [trigger] },
      }),
    ),
    http.get(`${workflowApi}/triggers`, () => HttpResponse.json({ items: [] })),
    http.get(`${workflowApi}/triggers/schedules`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [
          version(versionId, 1, {
            nodes: [stepNode(trigger.nodeId, 'http.poll', 'Watch feed')],
            edges: [],
            settings: {},
          }),
        ],
        nextCursor: null,
      }),
    ),
  );
  return renderLoadedApp(triggersPath);
}

it('shows the published polling step waiting for its baseline and when it will check', async () => {
  await renderPolling(health);
  const card = within(await screen.findByRole('article'));
  expect(
    await card.findByRole('heading', { name: 'Watch feed' }),
  ).toBeVisible();
  expect(card.getByText('Waiting for its first check')).toBeVisible();
  expect(card.getByText('Next check')).toBeVisible();
  expect(screen.queryByText('This version has no trigger')).toBeNull();
});

it('shows a safe credential repair message and the retained position while paused', async () => {
  await renderPolling({
    ...health,
    baselineEstablished: true,
    healthStatus: 'unhealthy',
    lastErrorCode: 'http.poll_authentication',
    paused: true,
  });
  const card = within(await screen.findByRole('article'));
  expect(card.getByText('Paused')).toBeVisible();
  expect(
    card.getByText(/Repair the connection.*resume triggers/u),
  ).toBeVisible();
  expect(
    card.getByText('Resuming keeps the items already recorded.'),
  ).toBeVisible();
  expect(card.queryByText('Next check')).toBeNull();
});
