import { expect, it } from 'vitest';

import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  actorId,
  workspaceId,
  otherWorkspaceId,
  randomUUID,
} from '../../../support/workflow-authoring.js';
import {
  query,
  execute,
  database,
  reader,
  publications,
  fixture,
  command,
} from './fixture.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';

export function registerFreezesUnpublishedDraftWithoutCreating(): void {
  it('freezes an unpublished draft without creating a publication and uses ordinary capacity', async () => {
    const f = await fixture();
    const intent = await command(f);
    const result = await database.workflowTests.start(intent);
    expect(await database.workflowTests.start(intent)).toEqual(result);
    expect(
      (
        await query<{ count: string }>(
          'select count(*) from app.workflow_versions where workflow_id=$1',
          [f.scope.workflowId],
        )
      )[0]?.count,
    ).toBe('0');
    const source = await reader.readForExecution({
      workspaceId,
      workflowVersionId: result.runId,
    });
    expect(source).toMatchObject({
      id: result.runId,
      workflowId: f.scope.workflowId,
      test: { pinnedNodeIds: [] },
    });
    expect(
      await publications.readForExecution({
        workspaceId,
        workflowVersionId: result.runId,
      }),
    ).toBeNull();
    expect(
      (await database.workflowTests.get({ ...f.scope, ...result })).graph,
    ).toEqual(f.graph);
    const rows = await query(
      'select run.trigger_type,run.started_by,run.failure_notification_destination_id,run.execution_entitlement_version,extract(epoch from (run.input_ref_expires_at-run.created_at))::integer retained_seconds from app.workflow_runs run where run.id=$1',
      [result.runId],
    );
    expect(rows[0]).toMatchObject({
      trigger_type: 'test',
      started_by: actorId,
      failure_notification_destination_id: null,
      retained_seconds: 604800,
    });
    expect(rows[0]?.execution_entitlement_version).not.toBeNull();
    await execute(
      "update app.workflow_drafts set graph_json=jsonb_set(graph_json::jsonb,'{nodes,1,label}','\"Changed later\"')::json,revision=revision+1 where workflow_id=$1",
      [f.scope.workflowId],
    );
    expect(
      (await database.workflowTests.get({ ...f.scope, ...result })).graph,
    ).toEqual(f.graph);
    expect(await database.workflowTests.start(intent)).toEqual(result);
    await expect(
      database.workflowTests.start({
        ...intent,
        request: { ...intent.request, input: { changed: true } },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('serializes two starts for the same person/workflow and preserves both command intents correctly', async () => {
    const f = await fixture();
    const first = await command(f);
    const second = { ...first, idempotencyKey: randomUUID() };
    const results = await Promise.allSettled([
      database.workflowTests.start(first),
      database.workflowTests.start(second),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { reason: 'already_running' } }]);
    expect((await database.workflowTests.list(f.scope)).items).toHaveLength(1);
  });

  it('refuses stale revisions and changed/expired pins before accepting a run', async () => {
    const f = await fixture();
    const intent = await command(f);
    await expect(
      database.workflowTests.start({
        ...intent,
        request: { ...intent.request, expectedRevision: 2 },
      }),
    ).rejects.toMatchObject({ reason: 'draft_changed' });
    await expect(
      database.workflowTests.start({
        ...intent,
        request: { ...intent.request, input: 'x'.repeat(262144) },
      }),
    ).rejects.toThrow('Stored execution value violates');
    const pin = await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: { pinned: 1 } },
    });
    await expect(database.workflowTests.start(intent)).rejects.toMatchObject({
      reason: 'samples_changed',
    });
    const pinnedIntent = await command(f);
    const accepted = await database.workflowTests.start(pinnedIntent);
    await database.stepSamples.remove({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: pin.sampleId,
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await reader.readForExecution({
          workspaceId,
          workflowVersionId: accepted.runId,
          nodeId: 'set',
        })
      )?.testSample?.output,
    ).toEqual({ pinned: 1 });
    expect(await database.workflowTests.start(pinnedIntent)).toEqual(accepted);
    await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: { pinned: 2 } },
    });
    await execute(
      "update app.workflow_step_samples set created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where workflow_id=$1",
      [f.scope.workflowId],
    );
    await expect(database.workflowTests.prepare(f.scope)).rejects.toMatchObject(
      { reason: 'stale_sample' },
    );
  });

  it('keeps test reads workspace-bound and cancellation durable/idempotent', async () => {
    const f = await fixture();
    const accepted = await database.workflowTests.start(await command(f));
    await expect(
      reader.readForExecution({
        workspaceId: otherWorkspaceId,
        workflowVersionId: accepted.runId,
      }),
    ).resolves.toBeNull();
    await expect(
      database.workflowTests.get({
        ...f.scope,
        workspaceId: otherWorkspaceId,
        ...accepted,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await database.workflowTests.cancel({ ...f.scope, ...accepted });
    await database.workflowTests.cancel({ ...f.scope, ...accepted });
    const events = await query<{ type: string }>(
      'select type from app.run_events where workflow_run_id=$1 order by sequence',
      [accepted.runId],
    );
    expect(events.map((event) => event.type)).toEqual([
      'run.queued',
      'run.cancel_requested',
    ]);
    const wakeups = await query<{ count: string }>(
      "select count(*) from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'",
      [accepted.runId],
    );
    expect(wakeups[0]?.count).toBe('2');
  });
}
