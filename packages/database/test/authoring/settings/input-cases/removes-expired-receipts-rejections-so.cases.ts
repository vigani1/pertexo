import { expect, it } from 'vitest';
import { createWorkflowInputCaseDatabase } from '../../../../src/authoring/input-cases/repository.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';

import {
  actorId,
  workspaceId,
  apiUrl,
  enforceTestRetention,
  authoring,
  executeAsOwner,
  queryAsOwner,
  randomUUID,
  parseDatabaseConfig,
  identity,
  otherActorId,
  purgeTestWorkspace,
} from '../../../support/workflow-authoring.js';
import { database, fixture } from './fixture.js';

export function registerRemovesExpiredReceiptsRejectionsSo(): void {
  it('removes expired receipts and rejections so a key can be reused', async () => {
    const scope = await fixture();
    const key = randomUUID();
    const command = {
      ...scope,
      name: 'Held fixture',
      input: null,
      idempotencyKey: key,
    };
    const created = await database.createCase(command);
    await executeAsOwner(
      `insert into app.workflow_manual_start_rejections(workspace_id,workflow_id,scope,key_hash,request_hash,expected_version_id,observed_version_id,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day')`,
      [
        workspaceId,
        scope.workflowId,
        `workflow:${scope.workflowId}:manual`,
        'c'.repeat(64),
        'd'.repeat(64),
        randomUUID(),
        scope.workflowVersionId,
      ],
    );
    await database.deleteCase({
      ...scope,
      caseId: created.caseId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await executeAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where workspace_id=$1 and operation like 'workflow.inputcase.%'",
      [workspaceId],
    );
    expect((await enforceTestRetention()).manual_start_rejections).toBe(1);
    const next = await database.createCase(command);
    expect(next.caseId).not.toBe(created.caseId);
    expect(next.replayed).toBe(false);
  });

  it('purges case receipts and bounded payload pages before versions, including unexpired manual rejection receipts', async () => {
    const id = randomUUID();
    const ownWorkspace = await identity.createWorkspaceWithOwner({
      id,
      name: 'Owned case purge',
      slug: `case-purge-${id}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scope = await fixture(ownWorkspace.id);
    const created = await database.createCase({
      ...scope,
      name: 'Purge fixture',
      input: 'x'.repeat(65000),
      idempotencyKey: randomUUID(),
    });
    for (let revision = 1; revision < 20; revision += 1)
      await database.updateCase({
        ...scope,
        caseId: created.caseId,
        expectedRevision: revision,
        name: 'Purge fixture',
        input: 'x'.repeat(65000),
        idempotencyKey: randomUUID(),
      });
    await executeAsOwner(
      `insert into app.workflow_manual_start_rejections(workspace_id,workflow_id,scope,key_hash,request_hash,expected_version_id,observed_version_id) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        scope.workspaceId,
        scope.workflowId,
        `workflow:${scope.workflowId}:manual`,
        'e'.repeat(64),
        'f'.repeat(64),
        randomUUID(),
        scope.workflowVersionId,
      ],
    );
    const payloadBytes = async () =>
      Number(
        (
          await queryAsOwner<{ bytes: string }>(
            'select coalesce(sum(canonical_bytes),0) bytes from app.workflow_input_case_payloads where workspace_id=$1',
            [scope.workspaceId],
          )
        )[0]?.bytes,
      );
    let remaining = await payloadBytes();
    const steps = await purgeTestWorkspace(scope.workspaceId, {
      pageSize: 100,
      afterPage: async () => {
        const after = await payloadBytes();
        expect(remaining - after).toBeLessThanOrEqual(1048576);
        remaining = after;
      },
    });
    expect(
      steps.filter((step) => step === 'workflow_input_case_payloads'),
    ).toHaveLength(2);
    expect(steps.indexOf('workflow_input_cases')).toBeLessThan(
      steps.indexOf('workflow_versions'),
    );
    const rows = await queryAsOwner<{
      cases: string;
      receipts: string;
      negative: string;
      versions: string;
    }>(
      `select (select count(*) from app.workflow_input_cases where workspace_id=$1) cases,(select count(*) from app.idempotency_records where workspace_id=$1) receipts,(select count(*) from app.workflow_manual_start_rejections where workspace_id=$1) negative,(select count(*) from app.workflow_versions where workspace_id=$1) versions`,
      [scope.workspaceId],
      scope.workspaceId,
    );
    expect(rows[0]).toEqual({
      cases: '0',
      receipts: '0',
      negative: '0',
      versions: '0',
    });
  });

  it('allows viewer/operator reads but independently denies authoring, and keeps archived cases inspect-only', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: 'Role-scoped case',
      input: null,
      idempotencyKey: randomUUID(),
    };
    const created = await database.createCase(command);
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
      [workspaceId, otherActorId],
      workspaceId,
    );
    for (const role of ['viewer', 'operator']) {
      await queryAsOwner(
        'update app.workspace_memberships set role=$3 where workspace_id=$1 and user_id=$2',
        [workspaceId, otherActorId, role],
        workspaceId,
      );
      expect(
        (
          await database.getCase({
            ...scope,
            actorId: otherActorId,
            caseId: created.caseId,
          })
        ).case.name,
      ).toBe('Role-scoped case');
      await expect(
        database.createCase({
          ...command,
          actorId: otherActorId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    await authoring.transitionWorkflowLifecycle({
      ...scope,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await database.getCase({ ...scope, caseId: created.caseId })).case.name,
    ).toBe('Role-scoped case');
    await expect(
      database.createCase({ ...command, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect((await database.createCase(command)).replayed).toBe(true);
    const restarted = createWorkflowInputCaseDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    try {
      expect(await restarted.createCase(command)).toEqual({
        caseId: created.caseId,
        revision: 1,
        replayed: true,
      });
    } finally {
      await restarted.close();
    }
  });
}
