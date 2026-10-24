import { fixture, save, paste, testIntent } from './support.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {IdempotencyConflictError} from '../../../src/platform/idempotency/repository.js';
import {
  authoring,
  actorId,
  workspaceId,
  otherWorkspaceId,
  randomUUID,
  queryAsOwner,
  executeAsOwner,
  enforceTestRetention,
  identity,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';

describe('shared draft step samples', () => {
  it('copies bounded JSON, lists metadata without values, and keeps payload out of receipts/audits', async () => {
    const f = await fixture();
    const command = paste(f, { privateSampleMarker: 'sample-data-only' });
    const pin = await authoring.stepSamples.put(command);
    expect(await authoring.stepSamples.put(command)).toEqual({
      ...pin,
      replayed: true,
    });
    const read = await authoring.stepSamples.get(f.scope);
    expect(read).toMatchObject({
      sample: { id: pin.sampleId, state: 'pinned', source: { kind: 'json' } },
      output: {
        kind: 'inline',
        value: { privateSampleMarker: 'sample-data-only' },
      },
    });
    const list = await authoring.stepSamples.list(f.scope);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('output');
    const facts = await queryAsOwner(
      'select result_ref from app.idempotency_records where resource_id=$1 union all select metadata from app.audit_events where target_id=$1',
      [pin.sampleId],
    );
    expect(JSON.stringify(facts)).not.toContain('sample-data-only');
    await expect(
      authoring.stepSamples.put({
        ...command,
        source: { kind: 'json', value: { changed: true } },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
  it('makes one CAS winner and recovers old commands without overwriting a newer sample', async () => {
    const f = await fixture();
    const first = await authoring.stepSamples.put(paste(f));
    const a = {
      ...paste(f, 'first replacement'),
      expectedSampleId: first.sampleId,
    };
    const b = {
      ...paste(f, 'second replacement'),
      expectedSampleId: first.sampleId,
    };
    const results = await Promise.allSettled([
      authoring.stepSamples.put(a),
      authoring.stepSamples.put(b),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('No CAS winner');
    const winningCommand = results[0].status === 'fulfilled' ? a : b;
    const removed = await authoring.stepSamples.remove({
      ...f.scope,
      expectedDraftRevision: f.revision,
      expectedSampleId: winner.value.sampleId,
      idempotencyKey: randomUUID(),
    });
    expect(removed.removed).toBe(true);
    expect(await authoring.stepSamples.put(winningCommand)).toEqual({
      ...winner.value,
      replayed: true,
    });
    expect((await authoring.stepSamples.get(f.scope)).sample).toBeNull();
  });
  it('keeps cosmetic edits, marks setup changes stale, and confirms only the current saved setup', async () => {
    const f = await fixture();
    const pin = await authoring.stepSamples.put(paste(f));
    const first = f.graph.nodes[0];
    if (first === undefined) throw new Error('No step');
    await save(f, {
      ...f.graph,
      nodes: [{ ...first, label: 'Renamed', position: { x: 20, y: 30 } }],
    });
    expect((await authoring.stepSamples.get(f.scope)).sample?.state).toBe(
      'pinned',
    );
    const changed = await save(f, {
      ...f.graph,
      nodes: [{ ...first, config: { value: 'changed' } }],
    });
    expect((await authoring.stepSamples.get(f.scope)).sample?.state).toBe(
      'stale',
    );
    await expect(
      authoring.acceptPreview({
        ...testIntent(f, pin.sampleId),
        draftRevision: changed.revision,
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    const confirmed = await authoring.stepSamples.put({
      ...f.scope,
      expectedDraftRevision: changed.revision,
      expectedSampleId: pin.sampleId,
      idempotencyKey: randomUUID(),
      source: { kind: 'confirm' },
    });
    expect(confirmed.sampleId).not.toBe(pin.sampleId);
    expect((await authoring.stepSamples.get(f.scope)).sample?.state).toBe(
      'pinned',
    );
  });
  it('records a pinned test without an attempt or outbox, with its exact output after pin removal', async () => {
    const f = await fixture();
    const pin = await authoring.stepSamples.put(paste(f, { amount: 42 }));
    const intent = testIntent(f, pin.sampleId);
    const accepted = await authoring.acceptPreview(intent);
    expect(accepted).toMatchObject({
      status: 'succeeded',
      pinnedSampleId: pin.sampleId,
      pinnedOutput: { kind: 'inline', value: { amount: 42 } },
      outboxEventId: null,
      previewAttemptId: null,
    });
    expect(
      await authoring.readPreview({
        workspaceId,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
    ).toMatchObject({
      status: 'succeeded',
      pinnedSampleId: pin.sampleId,
      startedAt: null,
      sideEffectClass: 'safe',
      mayContactProvider: false,
      output: { kind: 'inline', value: { amount: 42 } },
    });
    expect(
      await queryAsOwner(
        'select id from app.preview_attempts where preview_run_id=$1 union all select id from app.outbox_events where aggregate_id=$1',
        [accepted.previewRunId],
      ),
    ).toEqual([]);
    await authoring.stepSamples.remove({
      ...f.scope,
      expectedDraftRevision: f.revision,
      expectedSampleId: pin.sampleId,
      idempotencyKey: randomUUID(),
    });
    expect(await authoring.acceptPreview(intent)).toMatchObject({
      ...accepted,
      duplicate: true,
    });
    await expect(
      authoring.acceptPreview({
        ...intent,
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      }),
    ).rejects.toMatchObject({ reason: 'changed' });
  });
  it('copies a successful preview deliberately and the new sample outlives the source', async () => {
    const f = await fixture();
    const original = await authoring.stepSamples.put(paste(f, [1, 2, 3]));
    const accepted = await authoring.acceptPreview(
      testIntent(f, original.sampleId),
    );
    await authoring.stepSamples.put({
      ...f.scope,
      expectedDraftRevision: f.revision,
      expectedSampleId: original.sampleId,
      idempotencyKey: randomUUID(),
      source: { kind: 'preview', previewRunId: accepted.previewRunId },
    });
    await executeAsOwner(
      "update app.preview_runs set created_at=clock_timestamp()-interval '9 days',execution_deadline_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [accepted.previewRunId],
    );
    expect((await authoring.stepSamples.get(f.scope)).output).toEqual({
      kind: 'inline',
      value: [1, 2, 3],
    });
  });
  it('hides expired values, refuses confirmation, and removes them through maintenance', async () => {
    const f = await fixture();
    const pin = await authoring.stepSamples.put(paste(f));
    await executeAsOwner(
      "update app.workflow_step_samples set created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [pin.sampleId],
    );
    expect(await authoring.stepSamples.get(f.scope)).toMatchObject({
      sample: { state: 'expired', binding: '' },
      output: null,
    });
    await expect(
      authoring.stepSamples.put({
        ...f.scope,
        expectedDraftRevision: f.revision,
        expectedSampleId: pin.sampleId,
        idempotencyKey: randomUUID(),
        source: { kind: 'confirm' },
      }),
    ).rejects.toMatchObject({ reason: 'expired' });
    await expect(
      authoring.acceptPreview(testIntent(f, pin.sampleId)),
    ).rejects.toMatchObject({ reason: 'expired' });
    await enforceTestRetention();
    expect((await authoring.stepSamples.get(f.scope)).sample).toBeNull();
  });
  it('refuses oversized or file-backed values clearly', async () => {
    const f = await fixture();
    await expect(
      authoring.stepSamples.put(paste(f, 'x'.repeat(262144))),
    ).rejects.toMatchObject({ reason: 'value_invalid' });
    await expect(
      authoring.stepSamples.put(
        paste(f, {
          kind: 'artifact',
          artifactId: randomUUID(),
          byteLength: 1,
          mediaType: 'text/plain',
          sha256: 'a'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ reason: 'file_output' });
    const pin = await authoring.stepSamples.put(paste(f, 'x'.repeat(262142)));
    expect((await authoring.stepSamples.get(f.scope)).sample?.id).toBe(
      pin.sampleId,
    );
  });
  it('does not cross workspaces and erases samples for removed draft steps', async () => {
    const f = await fixture();
    await authoring.stepSamples.put(paste(f));
    await expect(
      authoring.stepSamples.get({ ...f.scope, workspaceId: otherWorkspaceId }),
    ).rejects.toThrow();
    await save(f, { ...f.graph, nodes: [] });
    expect((await authoring.stepSamples.get(f.scope)).sample).toBeNull();
  });
  it('purges retained sample data through the existing workspace deletion owner', async () => {
    const id = randomUUID();
    const workspace = await identity.createWorkspaceWithOwner({
      id,
      name: 'Sample purge',
      slug: `sample-purge-${id}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const f = await fixture(1, workspace.id);
    const pin = await authoring.stepSamples.put(
      paste(f, { retained: 'until-workspace-purge' }),
    );
    await purgeTestWorkspace(workspace.id, { pageSize: 1 });
    expect(
      await queryAsOwner(
        'select id from app.workflow_step_samples where id=$1',
        [pin.sampleId],
      ),
    ).toEqual([]);
    expect(
      await queryAsOwner('select id from app.workflows where workspace_id=$1', [
        workspace.id,
      ]),
    ).toEqual([]);
  });
});
