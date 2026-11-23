import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  connectionFormCatalog,
  PLATFORM_NODE_CATALOG,
} from '@pertexo/node-catalog';
import {
  loadPlatformRegistry,
  parseCommunityApprovalSet,
} from '@pertexo/node-catalog/server';

export const providerKey = 'community.example.widgets';
export const origin = 'https://widgets.example.test';
export const token = 'f64-widget-credential';
export const widget = 'North & East';
export const readPath = '/widgets/North%20%26%20East?count=2';

export async function approveRecipes() {
  const parent = path.resolve(
    import.meta.dirname,
    '../../../../../.pertexo/tmp',
  );
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'community-recipes-'));
  try {
    const file = 'widgets.json';
    const version = '1.0.0';
    const operation = {
      description: 'A widgets operation',
      connection: 'connection',
      input: {
        widget: { type: 'string', required: true },
        count: { type: 'integer', required: true },
      },
      output: { echo: { type: 'string', required: true } },
      path: '/widgets/{widget}',
      projection: { echo: '/result/echo' },
    };
    const bytes = JSON.stringify({
      format: 1,
      publisher: 'example',
      integration: 'widgets',
      version,
      hostRelease: { min: '0.0.0', below: '999.0.0' },
      origin,
      presentation: {
        name: 'Widgets',
        description: 'Widget inventory',
        icon: 'globe',
      },
      connection: {
        fields: { token: { label: 'Token', kind: 'secret' } },
        auth: { kind: 'named_header', field: 'token', name: 'X-Widget-Key' },
        test: { method: 'HEAD', path: '/account' },
      },
      actions: [
        {
          ...operation,
          key: 'read',
          name: 'Read widget',
          method: 'GET',
          query: { count: { input: 'count' } },
          sideEffect: 'safe',
        },
        {
          ...operation,
          key: 'write',
          name: 'Write widget',
          method: 'POST',
          body: { count: { input: 'count' } },
          sideEffect: 'unsafe',
        },
      ],
    });
    await writeFile(path.join(root, file), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await loadPlatformRegistry(
      parseCommunityApprovalSet(
        root,
        JSON.stringify([{ file, version, origin, providerKey, sha256 }]),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function recipeForm() {
  const form = connectionFormCatalog().find(
    (entry) => entry.providerKey === providerKey,
  );
  if (form === undefined) throw new Error('The approved connection is missing');
  return form;
}

export function recipeNode(action: 'read' | 'write', connectionId: string) {
  const step = PLATFORM_NODE_CATALOG.definitions.find(
    ({ integration }) =>
      integration?.providerKey === providerKey &&
      integration.operationKey === action,
  );
  if (step === undefined) throw new Error('The approved action is missing');
  return {
    step,
    node: {
      id: 'widgets',
      definition: step.definition,
      configVersion: step.configVersion,
      config: {},
      inputMappings: {
        widget: { kind: 'literal' as const, value: widget },
        count: { kind: 'literal' as const, value: 2 },
      },
      connectionRefs: { [recipeForm().slot]: connectionId },
    },
  };
}
