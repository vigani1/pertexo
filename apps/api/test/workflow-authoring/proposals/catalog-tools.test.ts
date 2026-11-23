import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import { ListNodeDefinitionsService } from '../../../src/catalog/catalog.service.js';
import {
  catalogToolResult,
  proposalTools,
} from '../../../src/workflow-authoring/proposals/catalog-tools.js';

it('reserves search results for current releases and opens retained details from the draft', () => {
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
  expect(
    catalogToolResult(catalog, 'search_catalog', { query: '' }, draft),
  ).toEqual([
    {
      ...current.definition,
      name: current.display?.name ?? current.definition.key,
    },
  ]);
  const identity = { key: current.definition.key, version: 2 };
  expect(
    catalogToolResult(catalog, 'get_step_details', identity, draft),
  ).toEqual({
    issue: 'step_unavailable',
  });
  expect(
    catalogToolResult(catalog, 'get_step_details', identity, {
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
    }),
  ).toMatchObject({ definition: identity });
});

it('advertises the same positive version bound and strict fields it accepts', () => {
  expect(
    proposalTools.find(({ name }) => name === 'get_step_details')?.inputSchema,
  ).toMatchObject({
    properties: { version: { type: 'integer', exclusiveMinimum: 0 } },
    required: ['key', 'version'],
    additionalProperties: false,
  });
});
