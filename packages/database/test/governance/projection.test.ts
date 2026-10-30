import { expect, it } from 'vitest';
import { projectAuditMetadata } from '../../src/governance/audit/projection.js';
it('projects typed audit facts and hides free text and legacy non-object JSON', () => {
  for (const value of [null, false, 42, 'legacy', [{ revision: 2 }]])
    expect(projectAuditMetadata(value)).toEqual({});
  expect(
    projectAuditMetadata({
      revision: 3,
      operation: 'rename_column',
      password: 'PRIVATE',
      actorRef: 'operator@example.test',
      role: 'admin',
      fromRole: 'builder',
      toRole: 'admin',
      changedNames: ['RATE'],
      values: { secret: 'PRIVATE' },
      secretVersionId: 'PRIVATE',
      actorKind: 'workflow',
    }),
  ).toEqual({
    revision: 3,
    operation: 'rename_column',
    actorRef: 'operator@example.test',
    role: 'admin',
    fromRole: 'builder',
    toRole: 'admin',
    actorKind: 'workflow',
    changedNames: ['RATE'],
  });
});

it('bounds legacy full variable-name unions while exposing their total count', () => {
  const names = Array.from(
    { length: 200 },
    (_, index) => `NAME_${String(index)}`,
  );
  const metadata = projectAuditMetadata({ changedNames: names });
  expect(metadata.changedNames).toEqual(names.slice(0, 100));
  expect(metadata).toMatchObject({
    changedCount: 200,
    changedNamesTruncated: true,
  });
  expect(projectAuditMetadata({ changedNames: ['PRIVATE=VALUE'] })).toEqual({});
});

it('exposes only typed membership origin metadata, never arbitrary source text', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const source of [
    'workspace_creation',
    'invitation',
    'jit',
    'directory',
  ]) {
    const metadata = {
      source,
      role: 'builder',
      status: 'active',
      roleRevision: 1,
      invitationId: id,
      organizationId: id,
      directoryUserId: id,
      credentialId: id,
    };
    expect(projectAuditMetadata(metadata)).toEqual(metadata);
  }
  expect(
    projectAuditMetadata({
      source: 'PRIVATE',
      status: 'PRIVATE',
      organizationId: 'PRIVATE',
      credentialId: 'PRIVATE',
    }),
  ).toEqual({});
});

// db-runs-06: a typed fact a writer records reaches the audit view; the
// operator status lookup records whether the command existed.
it.fails('projects the operator status lookup found fact', () => {
  for (const found of [true, false])
    expect(
      projectAuditMetadata({ actorRef: 'operator@example.test', found }),
    ).toEqual({ actorRef: 'operator@example.test', found });
});
