// Test-only: the real step schemas from the built catalog, as the API serves them.
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/browser-catalog.js';
import {
  nodeDefinitionListResponseSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http, type RequestHandler } from 'msw';
import { expect } from 'vitest';
import { mockServer } from '../mock-server';
import { renderApp } from '../render-app';
import { findCanvas, pressSave } from './editor-actions';
import {
  api,
  editorHandlers,
  editorPath,
  validHandler,
  workflowApi,
  workspaceId,
} from './workflow-editor';

export type GraphNode = WorkflowGraphContract['nodes'][number];

const { items: definitions } = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions.filter(
    ({ definition }) =>
      [
        'core.condition',
        'core.form',
        'core.manual',
        'core.request_input',
        'core.set',
        'http.request',
      ].includes(definition.key),
  ),
});

export function step(
  id: string,
  key: string,
  label: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    label,
    definition: { key, version: 1 },
    position: { x: 0, y: 80 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...extra,
  };
}

export function link(source: string, target: string, port = 'out') {
  return {
    id: `${source}-${target}`,
    source: { nodeId: source, port },
    target: { nodeId: target, port: 'in' },
  };
}

export const SAMPLE_LIMITS = { inlineBytes: 262144, depth: 64, members: 10000 };

/** A step's pinned sample: what the API returns for a pin in this state. */
export function pinHandler(
  nodeId: string,
  output: unknown,
  state: 'pinned' | 'expired' = 'pinned',
) {
  return http.get(`${workflowApi}/draft/nodes/${nodeId}/sample`, () =>
    HttpResponse.json({
      sample: {
        id: '11111111-1111-4111-8111-111111111111',
        nodeId,
        binding: 'sample-binding',
        state,
        source: { kind: 'json' },
        createdAt: '2026-10-16T10:00:00.000Z',
        expiresAt: '2026-11-15T10:00:00.000Z',
      },
      output,
      draftRevision: 1,
      limits: SAMPLE_LIMITS,
    }),
  );
}

/** Nothing recorded for any step, so a scenario only names what it has. */
function noRecordedRuns() {
  return http.get(`${workflowApi}/steps/:nodeId/runs`, () =>
    HttpResponse.json({ items: [] }),
  );
}

export async function openEditor(
  graph: WorkflowGraphContract,
  options: Readonly<{
    capabilities?: readonly string[];
    handlers?: readonly RequestHandler[];
    firstStep?: string;
  }> = {},
) {
  const saves: WorkflowGraphContract[] = [];
  mockServer.use(
    // First match wins, so a scenario's reads replace the empty defaults.
    ...(options.handlers ?? []),
    ...editorHandlers(
      (_request, body) => {
        saves.push(body.graph);
      },
      {
        graph,
        definitions,
        ...(options.capabilities === undefined
          ? {}
          : { capabilities: options.capabilities }),
      },
    ),
    validHandler(),
    http.get(`${workflowApi}/comments`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${api}/workspaces/${workspaceId}/variables`, () =>
      HttpResponse.json({ revision: 1, values: {}, descriptions: {} }),
    ),
    noRecordedRuns(),
  );
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = () => undefined;
  renderApp(editorPath);
  const event = userEvent.setup();
  const canvas = await findCanvas();
  const select = (label: string) => {
    fireEvent.click(canvas.getByText(label));
  };
  if (options.firstStep !== undefined) select(options.firstStep);
  return {
    event,
    canvas,
    select,
    saves,
    /** The step as the last save stored it. */
    savedStep: (nodeId: string) =>
      saves.at(-1)?.nodes.find((node) => node.id === nodeId),
    /** Saves now, and waits for the stored step to pass `check`. */
    saved: async (check: () => void) => {
      await waitFor(() => {
        pressSave();
        check();
      });
    },
    /** A forced save has had its chance, and a dirty draft would have gone. */
    expectNothingSaved: async () => {
      pressSave();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(saves).toEqual([]);
    },
  };
}

export async function chooseIn(
  event: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
) {
  await event.click(control);
  await event.click(
    await screen.findByRole('option', { name: option, hidden: false }),
  );
}
