import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import { setVariableSet } from '../../../support/variable-sets.js';
import { workspaceId, actorId } from '../../../support/workflow-authoring.js';
import {
  database,
  cases,
  scanner,
  reader,
  query,
  fixture,
  command,
  due,
  complete,
  runId,
} from './fixture.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';

export function registerFreezesPinsSharesExactOutput(): void {
  it('freezes pins and shares their exact output with every case after the pin is removed', async () => {
    const f = await fixture();
    const pin = await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: { amount: 42 } },
    });
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await database.stepSamples.remove({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: pin.sampleId,
      idempotencyKey: randomUUID(),
    });
    await complete(runId(first, 0), { amount: 42 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    const next = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const source = (
      await query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [runId(next, 1)],
      )
    )[0]?.workflow_version_id;
    expect(
      (
        await reader.readForExecution({
          workspaceId,
          workflowVersionId: source ?? '',
          nodeId: 'set',
        })
      )?.testSample?.output,
    ).toEqual({ amount: 42 });
    await complete(runId(next, 1), { amount: 42 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'failed', failed: 2 });
  });

  it('requires ordinary failed outcomes and records unknown and timeout clearly', async () => {
    const f = await fixture(4);
    for (const record of f.records)
      await cases.updateCase({
        ...f.scope,
        caseId: record.caseId,
        expectedRevision: 1,
        name: 'Expected failure',
        input: {},
        expectations: { outcome: 'fails', assertions: [] },
        idempotencyKey: randomUUID(),
      });
    const accepted = await database.workflowTestSuites.start(await command(f));
    for (const [ordinal, status] of [
      'failed',
      'outcome_unknown',
      'timed_out',
      'succeeded',
    ].entries()) {
      const detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
      await complete(runId(detail, ordinal), {}, status);
      await due(accepted.suiteId);
      await scanner.scan(25);
    }
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'failed', passed: 1, errors: 2, failed: 1 });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 1,
        })
      ).report,
    ).toMatchObject({ error: 'run_outcome_unknown', outcomeMatched: false });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 2,
        })
      ).report,
    ).toMatchObject({ error: 'run_timed_out' });
  });

  it('freezes empty and nonempty variable revisions across later cases', async () => {
    for (const populated of [false, true]) {
      const f = await fixture();
      if (populated) await setVariableSet(workspaceId, { RATE: 1 });
      const accepted = await database.workflowTestSuites.start(
        await command(f),
      );
      const first = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
      const before = (
        await query<{ variable_set_revision: number | null }>(
          'select variable_set_revision from app.workflow_runs where id=$1',
          [runId(first, 0)],
        )
      )[0]?.variable_set_revision;
      await setVariableSet(workspaceId, { RATE: 2 });
      await complete(runId(first, 0), { amount: 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
      const second = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
      expect(
        (
          await query<{ variable_set_revision: number | null }>(
            'select variable_set_revision from app.workflow_runs where id=$1',
            [runId(second, 1)],
          )
        )[0]?.variable_set_revision,
      ).toBe(before);
      expect(populated ? before !== null : before === null).toBe(true);
      await complete(runId(second, 1), { amount: 2 });
      await due(accepted.suiteId);
      await scanner.scan(25);
    }
  });

  it('stops future admissions when the starter loses authority', async () => {
    const f = await fixture(),
      accepted = await database.workflowTestSuites.start(await command(f)),
      first = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
    try {
      await query(
        "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
      await expect(
        database.workflowTestSuites.get({ ...f.scope, ...accepted }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      await complete(runId(first, 0), { amount: 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
    } finally {
      await query(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
    }
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({
      status: 'error',
      stopReason: 'authority_lost',
      passed: 1,
      skipped: 1,
      cases: [{ status: 'passed' }, { status: 'skipped', runId: null }],
    });
  });
}
