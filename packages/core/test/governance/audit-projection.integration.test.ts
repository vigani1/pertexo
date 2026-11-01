import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGovernanceStore } from '../../src/governance/index.js';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { WORKSPACE_VARIABLE_LIMITS } from '@pertexo/workflow-model';
import {
  apiUrl,
  actorId,
  workspaceId,
  queryAsOwner,
} from '../support/workflow-authoring.js';

let store: ReturnType<typeof createGovernanceStore>;
beforeAll(() => {
  store = createGovernanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
});
afterAll(() => store.close());

async function readProjectedMetadata(
  metadata: Readonly<Record<string, unknown>>,
) {
  const targetId = randomUUID();
  await queryAsOwner(
    "insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,metadata) values($1,$2,$3,'audit.quality_fixture','workflow',$4,$5::jsonb)",
    [randomUUID(), workspaceId, actorId, targetId, JSON.stringify(metadata)],
    workspaceId,
  );
  const result = await store.list({
    workspaceId,
    actorId,
    query: { targetId, limit: 1 },
  });
  expect(result.items).toHaveLength(1);
  return result.items[0]?.metadata;
}

it('projects every safe metadata family while leaving legacy payloads private', async () => {
  const legacyId = '00000000-0000-0000-0000-000000000000';
  const expected = {
    workflowId: legacyId,
    versionId: legacyId,
    secretVersionId: legacyId,
    previousSecretVersionId: legacyId,
    runId: legacyId,
    invocationId: legacyId,
    userId: legacyId,
    requestId: legacyId,
    publicationRequestId: legacyId,
    invitationId: legacyId,
    organizationId: legacyId,
    directoryUserId: legacyId,
    credentialId: legacyId,
    revision: 0,
    versionNumber: 2,
    affected: 3,
    roleRevision: 4,
    fromRevision: 5,
    toRevision: 6,
    auditRetentionDays: 365,
    columnCount: 8,
    changedCount: 9,
    tableLimit: 10,
    columnLimit: 11,
    rowLimit: 12,
    byteLimit: Number.MAX_SAFE_INTEGER,
    reused: false,
    dryRun: true,
    changedNamesTruncated: false,
    requirePublishApproval: true,
    actorRef: 'operator:quality/audit-1',
    operation: 'rename_column',
    actorKind: 'worker',
    source: 'directory',
    status: 'removed',
    role: 'owner',
    fromRole: 'viewer',
    toRole: 'builder',
    changedNames: ['AMOUNT'],
  };
  expect(
    await readProjectedMetadata({
      ...expected,
      providerMessage: 'PRIVATE_PROVIDER_TEXT',
      values: { secret: 'PRIVATE_PROVIDER_TEXT' },
    }),
  ).toEqual(expected);
});

it('does not expose malformed values under otherwise safe keys', async () => {
  expect(
    await readProjectedMetadata({
      workflowId: 'PRIVATE',
      revision: 1.5,
      affected: -1,
      byteLimit: Number.MAX_SAFE_INTEGER + 1,
      reused: 'true',
      actorRef: 'private value with spaces',
      operation: 'private_operation',
      actorKind: 'private_actor',
      source: 'private_source',
      status: 'private_status',
      role: 'super_admin',
      changedNames: ['not_a_variable'],
    }),
  ).toEqual({});
});

it('keeps legacy changed-name truncation authoritative over stored summary flags', async () => {
  const changedNames = Array.from(
    { length: WORKSPACE_VARIABLE_LIMITS.count + 1 },
    (_, index) => `ITEM_${String(index)}`,
  );
  expect(
    await readProjectedMetadata({
      changedNames,
      changedCount: 1,
      changedNamesTruncated: false,
    }),
  ).toEqual({
    changedNames: changedNames.slice(0, WORKSPACE_VARIABLE_LIMITS.count),
    changedCount: changedNames.length,
    changedNamesTruncated: true,
  });
});
