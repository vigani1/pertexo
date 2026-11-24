import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import { ListNodeDefinitionsService } from '../../../src/catalog/catalog.service.js';
import { proposalCatalog } from '../../../src/workflow-authoring/proposals/proposal-catalog.js';

it('finds Manual and Set fields from the words users use for the workflow', () => {
  const catalog = new ListNodeDefinitionsService(
    platformBrowserNodeDefinitionCatalog(),
  );
  const definitions = proposalCatalog(
    catalog,
    'Start from a manual trigger and add a Set step named Prepare order.',
    EMPTY_WORKFLOW_GRAPH,
  );
  expect(definitions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        definition: { key: 'core.manual', version: 1 },
      }),
      expect.objectContaining({ definition: { key: 'core.set', version: 2 } }),
    ]),
  );
  expect(definitions).not.toContainEqual(
    expect.objectContaining({
      definition: { key: 'core.set', version: 1 },
    }),
  );
});

const ordinaryRequests = [
  {
    request: 'Start it myself. Call a web API and post the result to Slack.',
    keys: ['core.manual', 'http.request', 'slack.send_message'],
  },
  {
    request: 'Every week, email a notification.',
    keys: ['core.schedule', 'email.send_notification'],
  },
  {
    request:
      'Start when an incoming request arrives, then route by category with a fallback.',
    keys: ['core.webhook', 'core.switch'],
  },
  {
    request:
      'When I start this, if the amount is over 50, add an approved field.',
    keys: ['core.manual', 'core.condition', 'core.set'],
  },
] as const;

it.each(ordinaryRequests)(
  'finds the needed steps for "$request" within the catalog budget',
  ({ request, keys }) => {
    const catalog = new ListNodeDefinitionsService(
      platformBrowserNodeDefinitionCatalog(),
    );
    const selected = proposalCatalog(catalog, request, EMPTY_WORKFLOW_GRAPH);
    expect(selected.map(({ definition }) => definition.key)).toEqual(
      expect.arrayContaining([...keys]),
    );
    expect(selected.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(
      16_384,
    );
  },
);

it('finds a requested addition even when the draft already uses many definitions', () => {
  const catalog = new ListNodeDefinitionsService(
    platformBrowserNodeDefinitionCatalog(),
  );
  const nodes = catalog
    .execute()
    .items.filter(({ definition }) => definition.key.startsWith('core.'))
    .slice(0, 12)
    .map(({ definition, configVersion }, index) => ({
      id: `step-${String(index)}`,
      definition,
      configVersion,
      position: { x: 0, y: 0 },
      config: {},
      inputMappings: {},
      connectionRefs: {},
    }));
  const selected = proposalCatalog(catalog, 'At the end, call a web API.', {
    ...EMPTY_WORKFLOW_GRAPH,
    nodes,
  });
  expect(selected.map(({ definition }) => definition.key)).toContain(
    'http.request',
  );
});

it('uses a referenced step label without treating its words as new steps', () => {
  const catalog = new ListNodeDefinitionsService(
    platformBrowserNodeDefinitionCatalog(),
  );
  const selected = proposalCatalog(
    catalog,
    'Could you call the Prepare order step Normalize order instead?',
    {
      ...EMPTY_WORKFLOW_GRAPH,
      nodes: [
        {
          id: 'prepare',
          label: 'Prepare order',
          definition: { key: 'core.set', version: 2 },
          configVersion: 1,
          position: { x: 0, y: 0 },
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
    },
  );
  expect(selected[0]?.definition.key).toBe('core.set');
  expect(selected.map(({ definition }) => definition.key)).not.toContain(
    'core.sort',
  );
});

it('includes retained definitions only when the draft uses them', () => {
  const { definitions } = platformBrowserNodeDefinitionCatalog();
  const current = definitions.find(
    ({ definition }) => definition.key === 'core.wait',
  );
  if (current === undefined) throw new Error('Missing Wait step');
  const retained = Array.from({ length: 12 }, (_, index) => ({
    ...current,
    definition: { ...current.definition, version: index + 2 },
    presentation: {
      name: 'Old Wait step',
      icon: 'globe',
      group: 'action' as const,
      community: {
        origin: 'https://community.example.test',
        publisher: 'community',
        retained: true as const,
      },
    },
  }));
  const catalog = new ListNodeDefinitionsService(
    { definitions: [...retained, current] },
    DEFAULT_CODE_SETTINGS,
  );
  const draft = EMPTY_WORKFLOW_GRAPH;
  expect(proposalCatalog(catalog, 'Add an Old Wait step', draft)).toEqual([
    expect.objectContaining({ definition: current.definition }),
  ]);
  const identity = { key: current.definition.key, version: 2 };
  const edit = {
    ...draft,
    nodes: [
      {
        id: 'existing',
        definition: identity,
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
  };
  expect(proposalCatalog(catalog, 'Rename my step', edit)).toContainEqual(
    expect.objectContaining({ definition: identity, existingOnly: true }),
  );
});
