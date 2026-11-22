import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import {
  apiBase,
  coldStart,
  fixtureRun,
  fixtureStatistics,
  fixtureVersion,
} from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  installRun,
  node,
  runId,
  workflowId,
  workspaceId,
} from './route/fixture';

it.each([
  {
    key: 'ai.classify',
    port: 'category-01',
    pinned: {
      categories: [
        {
          id: 'category-01',
          label: 'Payments',
          description: 'Billing questions',
        },
      ],
    },
    draft: {
      categories: [
        {
          id: 'category-01',
          label: 'Billing',
          description: 'Billing questions',
        },
      ],
    },
    label: 'Payments',
    newLabel: 'Billing',
  },
  {
    key: 'core.switch',
    port: 'case-02',
    pinned: {
      cases: [
        { id: 'case-02', equals: 'ready' },
        { id: 'case-01', equals: 'pending' },
      ],
    },
    draft: {
      cases: [
        { id: 'case-01', equals: 'pending' },
        { id: 'case-02', equals: 'ready' },
      ],
    },
    label: 'Case 1',
    newLabel: 'Case 2',
  },
  {
    key: 'ai.classify',
    port: 'category-01',
    pinned: {
      categories: [
        { id: 'category-01', label: ' ', description: 'Billing questions' },
      ],
    },
    draft: {
      categories: [
        {
          id: 'category-01',
          label: 'Billing',
          description: 'Billing questions',
        },
      ],
    },
    label: 'Category 1',
    newLabel: 'Billing',
  },
])(
  'shows $label for $key from the pinned version',
  async ({ key, port, pinned, draft, label, newLabel }) => {
    const graph = (config: unknown) => ({
      nodes: [
        {
          id: 'send-receipt',
          label: 'Route request',
          definition: { key, version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config,
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    });
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes: [node('succeeded')],
      output: { kind: 'inline', value: { selectedPort: port } },
    });
    const version = fixtureVersion(graph(pinned));
    mockServer.use(
      http.get(`${apiBase}/run-statistics`, () =>
        HttpResponse.json(fixtureStatistics()),
      ),
      http.get(`${apiBase}/workflows/${workflowId}/versions`, () =>
        HttpResponse.json({
          items: [
            {
              ...fixtureVersion(graph(draft)),
              id: '33333333-3333-4333-8333-333333333333',
              versionNumber: 8,
            },
            version,
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${apiBase}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json({ graph: graph(draft) }),
      ),
    );

    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`, { strict: true });
    expect(
      await screen.findByText(label, { exact: true }, coldStart),
    ).toBeVisible();
    expect(screen.queryByText(newLabel, { exact: true })).toBeNull();
  },
);
