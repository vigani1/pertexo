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
