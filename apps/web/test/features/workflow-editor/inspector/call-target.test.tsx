import type { WorkflowGraphContract } from '@pertexo/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  findCanvas,
  pressSave,
} from '../../../support/fixtures/editor-actions';
import {
  api,
  editorHandlers,
  editorPath,
  setDefinition,
  workspaceId,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';

const childId = '11111111-1111-4111-8111-111111111111';
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const pin = {
  workflowId: childId,
  workflowVersionId: firstId,
  executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
};
const declaration = {
  input: { type: 'string' as const },
  resultType: { type: 'string' as const },
  result: { kind: 'run_input' as const, path: '$' },
};
const definition = {
  ...setDefinition,
  definition: { key: 'core.call', version: 1 },
  family: 'logic' as const,
  configSchema: { type: 'object', properties: { target: { type: 'object' } } },
  inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
};
const graph: WorkflowGraphContract = {
  settings: {},
  edges: [],
  nodes: [
    {
      id: 'call',
      label: 'Reuse customer',
      definition: definition.definition,
      position: { x: 80, y: 80 },
      configVersion: 1,
      config: { target: pin },
      inputMappings: { input: { kind: 'literal', value: 'Ada' } },
      connectionRefs: {},
    },
  ],
};
async function open(capabilities?: readonly string[], paginated = false) {
  const versionReads: string[] = [];
  let saved: WorkflowGraphContract | undefined;
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved = body.graph;
      },
      {
        graph,
        definitions: [definition],
        ...(capabilities === undefined ? {} : { capabilities }),
      },
    ),
    http.get(`${api}/workspaces/${workspaceId}/workflows`, () =>
      HttpResponse.json({
        items: [
          {
            id: childId,
            workspaceId,
            name: 'Customer child',
            nameRevision: 1,
            lifecycleStatus: 'active',
            lifecycleRevision: 1,
            activationStatus: 'active',
            webhookSetupRequired: false,
            publishedVersionId: secondId,
            createdAt: '2026-10-10T00:00:00.000Z',
            updatedAt: '2026-10-10T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    ),
    http.get(
      `${api}/workspaces/${workspaceId}/workflows/${childId}/versions`,
      ({ request }) => {
        const url = new URL(request.url);
        versionReads.push(url.search);
        const first = {
          id: firstId,
          workflowId: childId,
          versionNumber: 1,
          graph: { nodes: [], edges: [], settings: {}, callable: declaration },
          checksum: pin.executableChecksum,
          graphDigest: 'f'.repeat(64),
          publishedAt: '2026-10-10T00:00:00.000Z',
        };
        const second = {
          ...first,
          id: secondId,
          versionNumber: 2,
          checksum: `wf:sha256:${'b'.repeat(64)}`,
          graphDigest: 'f'.repeat(64),
          publishedAt: '2026-10-10T01:00:00.000Z',
        };
        const exact = url.searchParams.get('versionId');
        if (exact !== null)
          return HttpResponse.json({
            items: [exact === firstId ? first : second],
            nextCursor: null,
          });
        if (paginated)
          return HttpResponse.json(
            url.searchParams.has('after')
              ? { items: [first], nextCursor: null }
              : { items: [second], nextCursor: 'older-page' },
          );
        return HttpResponse.json({ items: [second, first], nextCursor: null });
      },
    ),
  );
  await renderLoadedApp(editorPath, { strict: true });
  fireEvent.click((await findCanvas()).getByText('Reuse customer'));
  await screen.findByRole('button', { name: 'Upgrade to version 2' });
  return { read: () => saved, versionReads, user: userEvent.setup() };
}
describe('exact child version selection', { timeout: 30_000 }, () => {
  it('keeps the existing pin until explicit upgrade and restores it with Undo', async () => {
    const state = await open();
    expect(
      screen.getByRole('combobox', { name: 'Published version' }),
    ).toHaveTextContent('Version 1');
    expect(state.read()).toBeUndefined();
    await state.user.click(
      screen.getByRole('button', { name: 'Upgrade to version 2' }),
    );
    pressSave();
    await waitFor(() => {
      expect(state.read()?.nodes[0]?.config.target).toEqual({
        ...pin,
        workflowVersionId: secondId,
        executableChecksum: `wf:sha256:${'b'.repeat(64)}`,
      });
    });
    await state.user.click(screen.getByRole('button', { name: /Undo/u }));
    await waitFor(() => {
      expect(
        screen.getByRole('combobox', { name: 'Published version' }),
      ).toHaveTextContent('Version 1');
    });
    pressSave();
    await waitFor(() => {
      expect(state.read()?.nodes[0]?.config.target).toEqual(pin);
    });
  });
  it('lets readers inspect the pinned version without upgrading', async () => {
    await open(['workflow:read', 'run:read']);
    expect(
      screen.getByRole('combobox', { name: 'Child workflow' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('combobox', { name: 'Published version' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Upgrade to version 2' }),
    ).toBeDisabled();
  });
});
