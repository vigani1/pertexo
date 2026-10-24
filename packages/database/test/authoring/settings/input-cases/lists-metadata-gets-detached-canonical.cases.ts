import { expect, it } from 'vitest';
import {
  WorkflowInputCaseLimitError,
  WorkflowInputCaseRevisionConflictError,
} from '../../../../src/authoring/input-cases/store.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';
import { IdempotencyConflictError } from '../../../../src/platform/idempotency/repository.js';
import { createRetentionDatabase } from '../../../../src/lifecycle/retention/repository.js';
import {
  workspaceId,
  dispatcherUrl,
  authoring,
  queryAsOwner,
  randomUUID,
  parseDatabaseConfig,
} from '../../../support/workflow-authoring.js';
import { database, fixture } from './fixture.js';

export function registerListsMetadataGetsDetachedCanonical(): void {
  it('lists metadata only, gets detached canonical input and replays identifiers without names or JSON in receipts/audits', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: '  Synthetic input  ',
      input: { b: 2, a: 1 },
      idempotencyKey: randomUUID(),
    };
    const created = await database.createCase(command);
    expect(await database.createCase(command)).toEqual({
      ...created,
      replayed: true,
    });
    const list = await database.listCases({ ...scope, limit: 1 });
    expect(list.items[0]).toMatchObject({
      id: created.caseId,
      name: 'Synthetic input',
      workflowVersionId: scope.workflowVersionId,
      revision: 1,
    });
    expect(list.items[0]).not.toHaveProperty('input');
    expect(
      (await database.getCase({ ...scope, caseId: created.caseId })).case.input,
    ).toEqual({ a: 1, b: 2 });
    const facts = await queryAsOwner<{ receipt: unknown; metadata: unknown }>(
      `select to_jsonb(r) receipt,a.metadata from app.idempotency_records r join app.audit_events a on a.target_id=r.resource_id where r.resource_id=$1`,
      [created.caseId],
    );
    expect(JSON.stringify(facts)).not.toContain('Synthetic input');
    expect(JSON.stringify(facts)).not.toContain('"input"');
    await expect(
      database.createCase({ ...command, input: { changed: true } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const duplicated = await authoring.duplicateWorkflow({
      workspaceId: scope.workspaceId,
      workflowId: scope.workflowId,
      actorId: scope.actorId,
      name: 'Independent workflow copy',
      source: { kind: 'version', versionId: scope.workflowVersionId },
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await database.listCases({
          ...scope,
          workflowId: duplicated.workflowId,
          limit: 10,
        })
      ).items,
    ).toEqual([]);
  });

  it('serializes duplicate creation and strong CAS, exact retries precede stale revision, deletion never resurrects', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: 'Fixture',
      input: null,
      idempotencyKey: randomUUID(),
    };
    const pair = await Promise.all([
      database.createCase(command),
      database.createCase(command),
    ]);
    expect(new Set(pair.map((item) => item.caseId)).size).toBe(1);
    expect(pair.filter((item) => item.replayed)).toHaveLength(1);
    const caseId = pair[0].caseId;
    const edit = {
      ...scope,
      caseId,
      expectedRevision: 1,
      name: 'Edited',
      input: [1, 2],
      idempotencyKey: randomUUID(),
    };
    expect((await database.updateCase(edit)).revision).toBe(2);
    expect(await database.updateCase(edit)).toEqual({
      caseId,
      revision: 2,
      replayed: true,
    });
    await expect(
      database.updateCase({ ...edit, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkflowInputCaseRevisionConflictError);
    const deletion = {
      ...scope,
      caseId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    };
    expect((await database.deleteCase(deletion)).revision).toBe(3);
    await expect(database.getCase({ ...scope, caseId })).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    expect(await database.deleteCase(deletion)).toEqual({
      caseId,
      revision: 3,
      replayed: true,
    });
    expect(await database.createCase(command)).toEqual({
      caseId,
      revision: 1,
      replayed: true,
    });
    await expect(database.getCase({ ...scope, caseId })).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it('makes concurrent active-count admission atomic and deletion only releases counts, not retained bytes', async () => {
    const scope = await fixture();
    const created = await Promise.all(
      Array.from({ length: 49 }, (_, index) =>
        database.createCase({
          ...scope,
          name: `Fixture ${String(index)}`,
          input: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    const outcomes = await Promise.allSettled(
      [0, 1].map((index) =>
        database.createCase({
          ...scope,
          name: `Race ${String(index)}`,
          input: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(
      outcomes.find((item) => item.status === 'rejected')?.reason as unknown,
    ).toBeInstanceOf(WorkflowInputCaseLimitError);
    const retainedBefore = await queryAsOwner<{ bytes: string }>(
      'select sum(canonical_bytes) bytes from app.workflow_input_case_payloads where workspace_id=$1',
      [workspaceId],
    );
    const firstCreated = created[0];
    if (!firstCreated) throw new Error('Expected created case');
    await database.deleteCase({
      ...scope,
      caseId: firstCreated.caseId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await database.createCase({
      ...scope,
      name: 'New active slot',
      input: null,
      idempotencyKey: randomUUID(),
    });
    const retainedAfter = await queryAsOwner<{ bytes: string }>(
      'select sum(canonical_bytes) bytes from app.workflow_input_case_payloads where workspace_id=$1',
      [workspaceId],
    );
    expect(Number(retainedAfter[0]?.bytes)).toBe(
      Number(retainedBefore[0]?.bytes) + 4,
    );
  });

  it('retains replacement bytes until paged cleanup and charges update churn', async () => {
    const scope = await fixture();
    const created = await database.createCase({
      ...scope,
      name: 'Churn',
      input: 'x'.repeat(65000),
      idempotencyKey: randomUUID(),
    });
    let revision = 1;
    let denied = false;
    for (let index = 0; index < 70; index += 1) {
      try {
        const result = await database.updateCase({
          ...scope,
          caseId: created.caseId,
          expectedRevision: revision,
          name: 'Churn',
          input: 'x'.repeat(65000),
          idempotencyKey: randomUUID(),
        });
        revision = result.revision;
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WorkflowInputCaseLimitError);
        denied = true;
        break;
      }
    }
    expect(denied).toBe(true);
    const retention = createRetentionDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      { pageSize: 10 },
    );
    try {
      expect((await retention.enforce()).removed.input_case_payloads).toBe(10);
    } finally {
      await retention.close();
    }
    const remaining = await queryAsOwner<{ count: string }>(
      'select count(*) from app.workflow_input_case_payloads where workspace_id=$1 and case_id=$2',
      [workspaceId, created.caseId],
    );
    expect(Number(remaining[0]?.count)).toBeGreaterThan(1);
    expect(
      (await database.getCase({ ...scope, caseId: created.caseId })).case
        .revision,
    ).toBe(revision);
  });
}
