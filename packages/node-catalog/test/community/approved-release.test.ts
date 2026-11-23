import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PERTEXO_HOST_RELEASE } from '@pertexo/node-sdk/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  connectionFormCatalog,
  findConnectionDefinition,
  platformBrowserNodeDefinitionCatalog,
  resolvePlatformNodeDefinition,
} from '../../src/index.js';
import {
  communityApprovalDigest,
  createPlatformNodeRegistry,
  loadPlatformRegistry,
  parseCommunityApprovalSet,
  platformPortableDefinitionPolicy,
} from '../../src/server.js';

const release = {
  format: 1,
  publisher: 'example',
  integration: 'weather',
  version: '1.0.0',
  hostRelease: { min: '0.0.0', below: '999.0.0' },
  origin: 'https://weather.example.com',
  presentation: {
    name: 'Weather',
    description: 'Weather reports',
    icon: 'globe',
  },
  connection: {
    fields: { token: { label: 'Token', kind: 'secret' } },
    auth: { kind: 'bearer', field: 'token' },
    test: { method: 'GET', path: '/account' },
  },
  actions: [
    {
      key: 'forecast',
      name: 'Read forecast',
      description: 'Read the current forecast',
      connection: 'connection',
      input: { city: { type: 'string', required: true } },
      output: { temperature: { type: 'number', required: true } },
      method: 'GET',
      path: '/forecast/{city}',
      projection: { temperature: '/temperature' },
      sideEffect: 'safe',
    },
  ],
};

const file = 'weather.json';
const providerKey = 'community.example.weather';
let root: string;

beforeEach(async () => {
  const parent = path.resolve(import.meta.dirname, '../../../../.pertexo/tmp');
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(path.join(parent, 'community-registry-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function approval(body: string) {
  return {
    file,
    providerKey,
    version: release.version,
    origin: release.origin,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

async function prepare(value: unknown = release) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  await writeFile(path.join(root, file), body);
  return approval(body);
}

function load(
  ...approvals: readonly (ReturnType<typeof approval> & { current?: boolean })[]
) {
  return loadPlatformRegistry(
    parseCommunityApprovalSet(root, JSON.stringify(approvals)),
  );
}

it('refuses an edit to the approved file even when it is still valid JSON', async () => {
  const approved = await prepare();
  await writeFile(path.join(root, file), JSON.stringify(release) + '\n');
  await expect(load(approved)).rejects.toThrow('SHA-256 does not match');
});

it.each([
  '../weather.json',
  '/weather.json',
  './weather.json',
  'nested//weather.json',
  'nested\\weather.json',
])('refuses invalid approval path %s', async (invalidPath) => {
  const approved = await prepare();
  await expect(load({ ...approved, file: invalidPath })).rejects.toThrow(
    /package path/u,
  );
});

it('refuses symlinks for both a file and an intermediate directory', async () => {
  const approved = await prepare();
  await symlink(file, path.join(root, 'linked.json'));
  await symlink(root, path.join(root, 'dir'));
  await expect(load({ ...approved, file: 'linked.json' })).rejects.toThrow(
    /symlink/u,
  );
  await expect(load({ ...approved, file: `dir/${file}` })).rejects.toThrow(
    /symlink/u,
  );
});

it.each([
  ['format version', { ...release, format: 2 }, /format/u],
  [
    'executor ABI supplied by the file',
    { ...release, executorAbi: 1 },
    /executorAbi/u,
  ],
  [
    'incompatible host range',
    { ...release, hostRelease: { min: '0.0.0', below: PERTEXO_HOST_RELEASE } },
    `community.example.weather@1.0.0 has incompatible host range [0.0.0, ${PERTEXO_HOST_RELEASE}) for host ${PERTEXO_HOST_RELEASE}`,
  ],
  [
    'slot reference without a connection',
    { ...release, connection: undefined },
    /missing connection slot/u,
  ],
  [
    'secret default',
    {
      ...release,
      connection: {
        ...release.connection,
        fields: {
          token: { ...release.connection.fields.token, default: 'fake' },
        },
      },
    },
    /secret default/u,
  ],
  [
    'duplicate JSON key',
    JSON.stringify(release).replace(
      '"format":1',
      '"format":1,"f\\u006frmat":1',
    ),
    /duplicate JSON key "format"/u,
  ],
  ['built-in namespace', { ...release, providerKey: 'http' }, /providerKey/u],
])('refuses a manifest with %s', async (_description, value, reason) => {
  await expect(load(await prepare(value))).rejects.toThrow(reason);
});

it('checks the manifest origin and identity against the approval', async () => {
  const approved = await prepare();
  await expect(
    load({ ...approved, origin: 'https://other.example.com' }),
  ).rejects.toThrow(/does not match approval/u);
  await expect(
    load({ ...approved, providerKey: 'community.other.weather' }),
  ).rejects.toThrow(/does not match approval/u);
});

it('requires unique package keys before catalog startup', async () => {
  const approved = await prepare();
  await expect(load(approved, approved)).rejects.toThrow(
    'Duplicate integration module key',
  );
});

it('refuses a set whose operation count would overflow catalog discovery', async () => {
  const approvals = [];
  for (const integration of ['one', 'two', 'three', 'four', 'five']) {
    const body = JSON.stringify({
      ...release,
      integration,
      actions: Array.from({ length: 32 }, (_, index) => ({
        ...release.actions[0],
        key: `forecast${index.toString()}`,
      })),
    });
    const pathInRoot = `${integration}.json`;
    await writeFile(path.join(root, pathInRoot), body);
    approvals.push({
      ...approval(body),
      file: pathInRoot,
      providerKey: `community.example.${integration}`,
    });
  }
  await expect(load(...approvals)).rejects.toThrow('catalog limit');
});

it('verifies the selected approval set independently of order and file paths', async () => {
  const approved = await prepare();
  const versions = [
    { ...approved, current: true },
    { ...approved, file: 'archive.json', version: '0.9.0', current: false },
  ];
  const digest = communityApprovalDigest(versions);
  expect(
    parseCommunityApprovalSet(
      root,
      JSON.stringify(versions.toReversed()),
      digest,
    ),
  ).toBeDefined();
  expect(() =>
    parseCommunityApprovalSet(
      root,
      JSON.stringify(
        versions.map((version) => ({
          ...version,
          current: !version.current,
        })),
      ),
      digest,
    ),
  ).toThrow('approved set digest does not match');
});

it('rejects two current releases for the same provider', async () => {
  const original = await prepare();
  const second = JSON.stringify({ ...release, version: '2.0.0' });
  await writeFile(path.join(root, 'second.json'), second);
  await expect(
    load(
      { ...original, current: true },
      {
        ...approval(second),
        file: 'second.json',
        version: '2.0.0',
        current: true,
      },
    ),
  ).rejects.toThrow('multiple current releases');
});

it('merges unchanged contracts into the current presentation and retains an old changed pin', async () => {
  vi.resetModules();
  const { loadPlatformRegistry } = await import('../../src/server.js');
  const {
    platformBrowserNodeDefinitionCatalog,
    resolvePlatformNodeDefinition,
    connectionFormCatalog,
  } = await import('../../src/index.js');
  const old = {
    ...release,
    actions: [
      ...release.actions,
      {
        ...release.actions[0],
        key: 'alerts',
        name: 'Old alerts',
        path: '/alerts/{city}',
      },
    ],
  };
  const current = {
    ...old,
    version: '2.0.0',
    actions: [
      { ...old.actions[0], name: 'Current forecast' },
      { ...old.actions[1], name: 'Current alerts', path: '/v2/alerts/{city}' },
    ],
  };
  const oldApproval = await prepare(old);
  const body = JSON.stringify(current);
  await writeFile(path.join(root, 'current.json'), body);
  await loadPlatformRegistry(
    parseCommunityApprovalSet(
      root,
      JSON.stringify([
        { ...oldApproval, current: false },
        {
          ...approval(body),
          file: 'current.json',
          version: current.version,
          current: true,
        },
      ]),
    ),
  );
  const definitions = platformBrowserNodeDefinitionCatalog().definitions.filter(
    (definition) => definition.integration?.providerKey === providerKey,
  );
  expect(definitions).toHaveLength(3);
  for (const definition of definitions) {
    expect(
      resolvePlatformNodeDefinition(definition.definition).manifest,
    ).toMatchObject({
      definition: definition.definition,
    });
  }
  const currentForecast = definitions.find(
    ({ display }) => display?.name === 'Current forecast',
  );
  expect(currentForecast?.presentation?.community?.version).toBe('2.0.0');
  expect(currentForecast?.presentation?.community?.retained).toBeUndefined();
  const oldAlerts = definitions.find(
    ({ display }) => display?.name === 'Old alerts',
  );
  expect(oldAlerts?.presentation?.community).toMatchObject({
    version: '1.0.0',
    retained: true,
  });
  expect(
    connectionFormCatalog().filter((item) => item.providerKey === providerKey),
  ).toHaveLength(1);
});

it('loads the approved package into discovery, portability, credential validation and execution', async () => {
  await load(await prepare());
  const definition = platformBrowserNodeDefinitionCatalog().definitions.find(
    (entry) => entry.integration?.providerKey === providerKey,
  );
  assert(definition);
  expect(definition.definition.key).toMatch(/^community\.[a-z2-7]{52}$/u);
  expect(definition).toMatchObject({
    definition: {
      version: 1,
    },
    display: { name: 'Read forecast' },
    presentation: {
      icon: 'globe',
      community: { publisher: 'example', origin: release.origin },
    },
  });
  expect(definition).not.toHaveProperty('executor');
  const form = connectionFormCatalog().find(
    (entry) => entry.providerKey === providerKey,
  );
  assert(form);
  expect(form.fields).toMatchObject({
    properties: { token: { secret: true } },
  });
  expect(form).not.toHaveProperty('auth');
  const auth = findConnectionDefinition(form.authType, providerKey);
  expect(
    auth?.schema.parse({ type: form.authType, token: 'test-token' }),
  ).toEqual({
    type: form.authType,
    token: 'test-token',
  });
  const registration = resolvePlatformNodeDefinition(definition.definition);
  expect(platformPortableDefinitionPolicy().definitions).toContainEqual(
    expect.objectContaining({
      ...registration.manifest.definition,
      slots: [
        expect.objectContaining({
          providerKey,
          authType: form.authType,
          slot: form.slot,
        }),
      ],
    }),
  );
  const refuseTransport = () => {
    throw new Error('Unexpected provider request');
  };
  const { dispatchMode } = createPlatformNodeRegistry({
    httpClient: {
      redactText: refuseTransport,
      executeStreaming: refuseTransport,
    },
    fixedEndpointHttpClient: { execute: refuseTransport },
  });
  expect(dispatchMode(registration.manifest)).toBe('executor_controlled');
  await expect(load()).rejects.toThrow('process registry');
});
