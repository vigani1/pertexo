import { createHash } from 'node:crypto';
import { INTEGRATION_MODULES } from '@pertexo/integrations/server';
import { expect, it } from 'vitest';
import { registerIntegrationModules } from '../src/integration-modules.js';
import {
  PLATFORM_NODE_CATALOG,
  platformBrowserNodeDefinitionCatalog,
} from '../src/index.js';

import { isLegacyDefinition, isLegacyPolicy } from './legacy-catalog.js';

const [http, slack] = INTEGRATION_MODULES;

it('preserves the published catalog and every legacy browser projection byte for byte', () => {
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');

  // Recorded from the last catalog before integration modules were introduced.
  const legacyCatalog = {
    definitions: PLATFORM_NODE_CATALOG.definitions
      .filter(({ definition }) => isLegacyDefinition(definition))
      .map(({ agentTool: _agentTool, ...manifest }) => manifest),
    executors: PLATFORM_NODE_CATALOG.executors.filter(({ executor }) =>
      isLegacyDefinition(executor),
    ),
    policies: PLATFORM_NODE_CATALOG.policies.filter(isLegacyPolicy),
  };
  expect(digest(legacyCatalog)).toBe(
    'a7bc71739f8b115c36b9d73873e84775ef82ae998be88d74d5945b367936dbdd',
  );
  const definitions = platformBrowserNodeDefinitionCatalog()
    .definitions.filter(({ definition }) => isLegacyDefinition(definition))
    .map(({ presentation: _presentation, ...projection }) => projection);
  expect(digest({ definitions })).toBe(
    'b03fc3cb0eec3e7943bf07f0519a65d1c62c7243e98c21779cf8fe1715b31ab4',
  );
});

it('advertises table IDs only for the new Find rows and Agent versions', () => {
  const definition = (key: string, version: number) =>
    PLATFORM_NODE_CATALOG.definitions.find(
      (entry) =>
        entry.definition.key === key && entry.definition.version === version,
    )?.configSchema;
  expect(definition('core.table_find', 1)?.properties).not.toHaveProperty(
    'tableId',
  );
  expect(definition('core.table_find', 2)?.properties).toHaveProperty(
    'tableId',
  );
  const legacy = JSON.stringify(definition('ai.agent', 1));
  const current = JSON.stringify(definition('ai.agent', 2));
  expect(legacy).not.toContain('"tableId"');
  expect(current).toContain('"tableId"');
});

it('declares Find rows as the only Agent read tool and Insert row and Slack as write tools', () => {
  const tools = (effect: 'read' | 'write') =>
    PLATFORM_NODE_CATALOG.definitions
      .filter(({ agentTool }) => agentTool?.effect === effect)
      .map(({ definition }) => definition);
  expect(tools('read')).toEqual([
    { key: 'core.table_find', version: 1 },
    { key: 'core.table_find', version: 2 },
  ]);
  expect(tools('write')).toEqual([
    { key: 'core.table_insert', version: 1 },
    { key: 'slack.send_message', version: 1 },
  ]);
});

it('refuses two modules with the same key during catalog assembly', () => {
  expect(() =>
    registerIntegrationModules([http, { ...slack, key: http.key }]),
  ).toThrow('Duplicate integration module key: http');
});

it('refuses two modules that claim the same step during catalog assembly', () => {
  expect(() =>
    registerIntegrationModules([http, { ...slack, steps: http.steps }]),
  ).toThrow('Duplicate integration step key: http.request');
});

it('refuses a connection whose slot has no primary definition during catalog assembly', () => {
  expect(() =>
    registerIntegrationModules([
      {
        ...http,
        connections: http.connections.map((connection) => ({
          ...connection,
          slot: { ...connection.slot, primary: false },
        })),
      },
    ]),
  ).toThrow('Invalid integration slot reference');
});
