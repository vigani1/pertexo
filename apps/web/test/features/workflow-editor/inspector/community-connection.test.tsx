import { AddStepItem } from '@/features/workflow-editor/components/add-step/item';
import { groupStepChoices } from '@/features/workflow-editor/model/step-catalog';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import type {
  ConnectionFormDefinition,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import { findCanvas } from '../../../support/fixtures/editor-actions';
import {
  api,
  editorHandlers,
  editorPath,
  setDefinition,
  validHandler,
  workspace,
  workflowApi,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';

it('opens the credential form pinned by a community step', async () => {
  const slot = `community.${'a'.repeat(52)}`;
  const form: ConnectionFormDefinition = {
    providerKey: 'community.example.posts',
    authType: `community_${'a'.repeat(52)}`,
    presentation: {
      choice: 'community.example.posts',
      name: 'Example Posts',
      purpose: 'Read posts by ID.',
      credential: 'API key',
      savedCredential: 'API key',
      usedBy: 'Get post',
      nameSuffix: 'Example Posts',
    },
    icon: 'globe',
    fields: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'API key', secret: true },
      },
      required: ['apiKey'],
    },
    slot,
    test: 'http',
    testInput: 'provider',
  };
  const action: NodeDefinitionCatalogItem = {
    ...setDefinition,
    definition: { key: `community.${'b'.repeat(52)}`, version: 1 },
    display: { name: 'Get post', description: 'Read one post.' },
    connectionRequirements: [slot],
    credentialRequirements: [slot],
  };
  mockServer.use(
    validHandler(),
    ...editorHandlers(() => undefined, {
      definitions: [action],
      capabilities: [
        ...workspace.capabilities,
        'connection:use',
        'connection:manage',
      ],
      graph: {
        settings: {},
        edges: [],
        nodes: [
          {
            id: 'post',
            label: 'Read a post',
            definition: action.definition,
            position: { x: 80, y: 80 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
      },
    }),
  );
  mockServer.use(
    http.get(`${workflowApi}/comments`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  mockServer.use(
    http.get(`${api}/node-definitions`, () =>
      HttpResponse.json({ items: [action], connections: [form] }),
    ),
  );

  await renderLoadedApp(editorPath);
  fireEvent.click((await findCanvas()).getByText('Read a post'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'New Example Posts connection' }),
  );
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Connect Example Posts' }),
  );
  expect(dialog.getByLabelText('API key')).toHaveAttribute('type', 'password');
});

it('shows the community publisher and destination in the step picker', () => {
  const definition = {
    ...setDefinition,
    definition: { key: `community.${'b'.repeat(52)}`, version: 1 },
    family: 'action',
    display: { name: 'Get post', description: 'Read one post by ID.' },
    presentation: {
      name: 'Get post',
      group: 'action',
      icon: 'globe',
      community: {
        publisher: 'example',
        origin: 'https://example-posts.provider.test',
      },
    },
  } satisfies NodeDefinitionCatalogItem;
  const choice = groupStepChoices([definition], 'Get post')[0]?.choices[0];
  if (choice === undefined)
    throw new Error('The catalog did not offer Get post.');
  render(<AddStepItem choice={choice} onAdd={() => undefined} />);
  const tile = within(screen.getByRole('button', { name: /^Get post/u }));
  expect(tile.getByText(/Community · example/u)).toBeVisible();
  expect(tile.getByText('https://example-posts.provider.test')).toBeVisible();
});
