import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findIntegrationDispatch,
  integrationKeys,
} from './validate-integration-dispatch.mjs';

const moduleFile = 'packages/integrations/src/example/example.module.ts';
const declaration = "export const EXAMPLE_MODULE = { key: 'example' };";
const keys = integrationKeys([
  [moduleFile, declaration],
  [
    'packages/integrations/src/example/auth.definition.ts',
    "const auth = { authType: 'custom_auth' };",
  ],
  [
    'packages/integrations/src/example/run.definition.ts',
    "const step = { key: 'example.run' };",
  ],
  [
    'packages/integrations/src/http/http.module.ts',
    "const module = { key: 'http' };",
  ],
]);

for (const [name, file, text] of [
  [
    'a second executor registration list with a renamed import',
    'packages/node-catalog/src/server.ts',
    "import { EXAMPLE_MODULE as module } from '@pertexo/integrations/server';\nconst executors = [module.steps[0]];",
  ],
  [
    'a provider branch in the web picker',
    'apps/web/src/features/connections/components/provider-tile.tsx',
    "const icon = provider === 'example' ? ExampleIcon : DefaultIcon;",
  ],
  [
    'a versioned integration key in editor presentation',
    'apps/web/src/features/catalog/model/steps/registry.ts',
    "const stepIcons = { ['example.run@1']: ExampleIcon };",
  ],
  [
    'a polling adapter map in the worker',
    'apps/worker/src/triggers/fetch-poll.ts',
    'const fetchers = new Map([[\x60example.run\x60, fetchExample]]);',
  ],
  [
    'a credential membership list in the wire schema',
    'packages/contracts/src/schemas/connections/connection-fields.ts',
    "const list = z.enum(['custom_auth']);",
  ],
  [
    'a credential membership list in the current SQL schema',
    'packages/database/src/schema/connections.ts',
    "check('auth_type_valid', sql\x60auth_type in ('custom_auth')\x60);",
  ],
  [
    'a second use of an existing protocol literal',
    'apps/worker/src/providers/connections.ts',
    "const first = { expectedProviderKey: 'http' }; const second = { expectedProviderKey: 'http' };",
  ],
]) {
  test(`refuses ${name}`, () => {
    assert.equal(findIntegrationDispatch(file, text, keys).length, 1);
  });
}

test('accepts module declarations, historical migrations and generic protocols', () => {
  assert.deepEqual(findIntegrationDispatch(moduleFile, declaration, keys), []);
  assert.deepEqual(
    findIntegrationDispatch(
      'packages/database/migrations/0001.sql',
      "CHECK (auth_type IN ('custom_auth'))",
      keys,
    ),
    [],
  );
  assert.deepEqual(
    findIntegrationDispatch(
      'apps/worker/src/providers/connections.ts',
      "import { OAuth2TokenFailure } from '@pertexo/integrations/server'; const request = { expectedProviderKey: 'http' };",
      keys,
    ),
    [],
  );
});

test('accepts dispatch through the registry', () => {
  assert.deepEqual(
    findIntegrationDispatch(
      'packages/node-catalog/src/server.ts',
      'const executors = INTEGRATION_MODULE_REGISTRY.createExecutors(dependencies);',
      keys,
    ),
    [],
  );
});
