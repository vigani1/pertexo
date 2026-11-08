import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  beforeAllFixture1,
  afterAllFixture2,
  fixture,
  store,
} from './admission/admission.fixture.js';
import { admin } from '../../lifecycle/calls/calls.fixture.js';
import { revokeRemovedFormAccess } from '../../../src/triggers/forms/publication.repository.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
it('stores a sealed copy on creation and rotation, omits it from receipts, and clears both fields on revoke', async () => {
  const f = await fixture();
  const capability = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    capability,
    expectedRevision: 0,
    idempotencyKey: 'enable-sealed',
  });
  const row = async () =>
    (
      await admin.query(
        'select capability_hash,sealed_capability from app.workflow_forms where workflow_id=$1',
        [f.workflowId],
      )
    ).rows[0] as { capability_hash: string | null; sealed_capability: unknown };
  const created = await row();
  expect(created.sealed_capability).toMatchObject({
    ciphertext: expect.any(String) as unknown,
  });
  expect(JSON.stringify(created)).not.toContain(capability);
  expect(access).not.toHaveProperty('sealedCapability');
  expect((await store.access(f)).sealedCapability).toEqual(
    created.sealed_capability,
  );
  const rotated = await store.setAccess({
    ...f,
    access: 'public',
    capability: randomBytes(32).toString('base64url'),
    expectedRevision: access.revision,
    idempotencyKey: 'rotate-sealed',
  });
  const after = await row();
  expect(after.sealed_capability).not.toEqual(created.sealed_capability);
  expect(after.capability_hash).not.toEqual(created.capability_hash);
  await store.setAccess({
    ...f,
    access: 'members',
    expectedRevision: rotated.revision,
    idempotencyKey: 'revoke-sealed',
  });
  expect(await row()).toEqual({
    capability_hash: null,
    sealed_capability: null,
  });
  await store.setAccess({
    ...f,
    access: 'public',
    capability,
    expectedRevision: rotated.revision + 1,
    idempotencyKey: 'reopen-sealed',
  });
  await revokeRemovedFormAccess(admin, f.workspaceId, f.workflowId, {
    nodes: [],
    edges: [],
    settings: {},
  });
  expect(await row()).toEqual({
    capability_hash: null,
    sealed_capability: null,
  });
});
it('keeps a legacy link usable without a sealed copy', async () => {
  const f = await fixture();
  const capability = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    capability,
    expectedRevision: 0,
    idempotencyKey: 'legacy',
  });
  await admin.query(
    'update app.workflow_forms set sealed_capability=null where workflow_id=$1',
    [f.workflowId],
  );
  expect((await store.access(f)).sealedCapability).toBeNull();
  if (access.publicId === null) throw new Error('Public identity missing');
  const grant = await store.discover({
    publicId: access.publicId,
    capability,
  });
  expect(await store.read(f, grant)).toMatchObject({ versionId: f.versionId });
});
