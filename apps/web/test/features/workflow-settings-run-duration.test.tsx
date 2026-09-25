import { http } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_EXECUTION_LIMITS_V1 } from '@pertexo/workflow-model/graph-contract';
import { RUN_DURATION_LIMIT_MS } from '@/features/workflow-settings/model/run-duration';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  draftResponse,
  emptyGraph,
  etag,
  etagB,
  graphWithNode,
  installQueries,
  problem,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const settingsPath = `/w/${workspaceId}/workflows/${workflowId}/settings`;

type SavedDraft = Readonly<{
  ifMatch: string | null;
  graph: { settings: Record<string, unknown>; nodes: unknown[] };
}>;

async function chooseDuration(label: string) {
  const event = userEvent.setup();
  const section = await screen.findByRole('region', { name: 'Run duration' });
  await event.click(
    await within(section).findByRole('combobox', {
      name: 'Maximum run duration',
    }),
  );
  await event.click(await screen.findByRole('option', { name: label }));
  return { event, section };
}

describe('workflow settings: run duration', () => {
  it('matches the platform limit', () => {
    expect(RUN_DURATION_LIMIT_MS).toBe(
      WORKFLOW_EXECUTION_LIMITS_V1.maxRunDurationMs,
    );
  });

  it('saves a new maximum into the draft with its ETag and says to publish', async () => {
    const saves: SavedDraft[] = [];
    let graph: unknown = emptyGraph;
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/draft`, () =>
        draftResponse(graph, saves.length === 0 ? etag : etagB),
      ),
      http.put(`${workflowApi}/draft`, async ({ request }) => {
        const body = (await request.json()) as {
          graph: SavedDraft['graph'];
        };
        saves.push({ ifMatch: request.headers.get('if-match'), ...body });
        graph = body.graph;
        return draftResponse(graph, etagB);
      }),
    );
    renderApp(settingsPath);
    const { section } = await chooseDuration('30 minutes');
    expect(
      await screen.findByText('Runs may take up to 30 minutes in the draft'),
    ).toBeVisible();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.ifMatch).toBe(etag);
    expect(saves[0]?.graph.settings).toEqual({ maxRunDurationMs: 1_800_000 });
    expect(
      await within(section).findByText(
        'The draft says 30 minutes. Live v1 stops runs after 1 hour until you publish.',
      ),
    ).toBeVisible();
  });

  it('applies again to the latest draft only when asked after a conflict', async () => {
    const saves: SavedDraft[] = [];
    let current: { graph: unknown; etag: string } = {
      graph: emptyGraph,
      etag,
    };
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/draft`, () =>
        draftResponse(current.graph, current.etag),
      ),
      http.put(`${workflowApi}/draft`, async ({ request }) => {
        const body = (await request.json()) as {
          graph: SavedDraft['graph'];
        };
        saves.push({ ifMatch: request.headers.get('if-match'), ...body });
        if (saves.length === 1) {
          // Someone saved a new step meanwhile.
          current = { graph: graphWithNode('theirs'), etag: etagB };
          return problem(412, 'workflow.revision_conflict');
        }
        current = { graph: body.graph, etag: `"draft-v1.${'d'.repeat(43)}"` };
        return draftResponse(current.graph, current.etag);
      }),
    );
    renderApp(settingsPath);
    const { event, section } = await chooseDuration('15 minutes');
    expect(
      await within(section).findByText(
        /The draft changed while this was saving/u,
      ),
    ).toBeVisible();
    expect(saves).toHaveLength(1);
    await event.click(
      within(section).getByRole('button', { name: 'Apply again' }),
    );
    expect(
      await screen.findByText('Runs may take up to 15 minutes in the draft'),
    ).toBeVisible();
    expect(saves[1]?.ifMatch).toBe(etagB);
    // Their new step is kept.
    expect(saves[1]?.graph.nodes).toHaveLength(1);
    expect(saves[1]?.graph.settings).toEqual({ maxRunDurationMs: 900_000 });
  });

  it('shows the duration without offering changes to roles that can’t edit', async () => {
    installQueries([]);
    renderApp(settingsPath);
    const section = await screen.findByRole('region', { name: 'Run duration' });
    expect(
      await within(section).findByRole('combobox', {
        name: 'Maximum run duration',
      }),
    ).toHaveTextContent('1 hour');
    expect(within(section).getByRole('combobox')).toBeDisabled();
    expect(
      within(section).getByText(/Your role can’t change this/u),
    ).toBeVisible();
  });
});
