import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  store,
} from './admission/admission.fixture.js';
import { purgeWorkspace } from '../../support/workspace-purge.js';
import {
  adminUrl,
  maintenanceUrl,
  withDatabase,
} from '../../lifecycle/retention.support.js';
import { admin } from '../../lifecycle/calls/calls.fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

it('replays setAccess without changing the stored link or advancing its revision', async () => {
  const f = await fixture();
  const capability = randomBytes(32).toString('base64url');
  const input = {
    ...f,
    access: 'public' as const,
    capability,
    expectedRevision: 0,
    idempotencyKey: 'same-access-command',
  };
  const first = await store.setAccess(input);
  const before = await store.access(f);
  expect(await store.setAccess(input)).toEqual(first);
  expect(await store.access(f)).toEqual(before);
  expect(JSON.stringify(first)).not.toContain(capability);
});

it('allows exactly one concurrent regeneration and keeps only its link usable', async () => {
  const f = await fixture();
  const original = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    capability: original,
    expectedRevision: 0,
    idempotencyKey: 'initial-link',
  });
  if (access.publicId === null) throw new Error('Missing public identity');
  const capabilities = [
    randomBytes(32).toString('base64url'),
    randomBytes(32).toString('base64url'),
  ];
  const outcomes = await Promise.allSettled(
    capabilities.map((capability, index) =>
      store.setAccess({
        ...f,
        access: 'public',
        capability,
        expectedRevision: access.revision,
        idempotencyKey: `regenerate-${String(index)}`,
      }),
    ),
  );
  expect(
    outcomes.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    outcomes.filter((result) => result.status === 'rejected'),
  ).toMatchObject([{ reason: { name: 'FormAccessConflictError' } }]);
  expect((await store.access(f)).revision).toBe(access.revision + 1);
  await expect(
    store.discover({ publicId: access.publicId, capability: original }),
  ).rejects.toMatchObject({ name: 'FormUnavailableError' });
  for (const [index, capability] of capabilities.entries()) {
    const discovery = store.discover({ publicId: access.publicId, capability });
    if (outcomes[index]?.status === 'fulfilled') {
      const grant = await discovery;
      expect(await store.read(f, grant)).toMatchObject({
        versionId: f.versionId,
      });
    } else
      await expect(discovery).rejects.toMatchObject({
        name: 'FormUnavailableError',
      });
  }
});

it('upgrades a legacy link once and rejects the old posted link', async () => {
  const f = await fixture();
  const oldCapability = randomBytes(32).toString('base64url');
  const initial = await store.setAccess({
    ...f,
    access: 'public',
    capability: oldCapability,
    expectedRevision: 0,
    idempotencyKey: 'legacy-link',
  });
  if (initial.publicId === null) throw new Error('Missing public identity');
  await admin.query(
    'update app.workflow_forms set sealed_capability=null where workflow_id=$1',
    [f.workflowId],
  );
  const oldGrant = await store.discover({
    publicId: initial.publicId,
    capability: oldCapability,
  });
  expect(await store.read(f, oldGrant)).toMatchObject({
    versionId: f.versionId,
  });
  const capability = randomBytes(32).toString('base64url');
  await store.setAccess({
    ...f,
    access: 'public',
    capability,
    expectedRevision: initial.revision,
    idempotencyKey: 'upgrade-legacy',
  });
  expect((await store.access(f)).sealedCapability).not.toBeNull();
  await expect(
    store.discover({ publicId: initial.publicId, capability: oldCapability }),
  ).rejects.toMatchObject({ name: 'FormUnavailableError' });
  await expect(store.read(f, oldGrant)).rejects.toMatchObject({
    name: 'FormUnavailableError',
  });
  const grant = await store.discover({
    publicId: initial.publicId,
    capability,
  });
  expect(await store.read(f, grant)).toMatchObject({ versionId: f.versionId });
});

it('removes the hash and sealed copy when the workspace is purged', async () => {
  const f = await fixture();
  const capability = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    capability,
    expectedRevision: 0,
    idempotencyKey: 'purged-link',
  });
  expect((await store.access(f)).sealedCapability).not.toBeNull();
  await purgeWorkspace({
    adminUrl: withDatabase(adminUrl),
    maintenanceUrl,
    workspaceId: f.workspaceId,
  });
  expect(
    (
      await admin.query(
        'select capability_hash,sealed_capability from app.workflow_forms where workflow_id=$1',
        [f.workflowId],
      )
    ).rows,
  ).toEqual([]);
  if (access.publicId === null) throw new Error('Missing public identity');
  await expect(
    store.discover({ publicId: access.publicId, capability }),
  ).rejects.toMatchObject({ name: 'FormUnavailableError' });
});
