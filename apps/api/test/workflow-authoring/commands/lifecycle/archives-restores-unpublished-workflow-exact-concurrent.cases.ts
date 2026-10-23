import { expect, it } from 'vitest';

import { expectProblem, mutationHeaders } from '../../lifecycle.support.js';
import {
  type LifecycleResponse,
  lifecyclePath,
  expectLifecycleResponse,
  expectHistoryUnchanged,
  lifecycleFacts,
  fixture,
} from './fixture.js';

export function registerArchivesRestoresUnpublishedWorkflowExactConcurrent(): void {
  it('archives and restores an unpublished workflow with exact concurrent idempotency and CAS', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const path = lifecyclePath(workspaceId, ids.unpublished, 'archive');
    const archiveHeaders = mutationHeaders(owner, {
      'idempotency-key': 'unpublished-archive-concurrent',
    });
    const archiveRequests = await Promise.all([
      application.inject({
        method: 'POST',
        url: path,
        headers: archiveHeaders,
        payload: { expectedLifecycleRevision: 1 },
      }),
      application.inject({
        method: 'POST',
        url: path,
        headers: archiveHeaders,
        payload: { expectedLifecycleRevision: 1 },
      }),
    ]);
    expect(archiveRequests.map(({ statusCode }) => statusCode).sort()).toEqual([
      202, 202,
    ]);
    const archiveBodies = archiveRequests.map((response) =>
      response.json<LifecycleResponse>(),
    );
    const acceptedArchive = archiveBodies.find(({ replayed }) => !replayed);
    if (acceptedArchive === undefined)
      throw new Error('accepted archive response missing');
    expect(archiveBodies.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(archiveBodies[0]?.workflow).toMatchObject({
      id: ids.unpublished,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
    });
    expect(archiveBodies[0]?.workflow).toEqual(archiveBodies[1]?.workflow);
    expectLifecycleResponse(archiveRequests[0], {
      workspaceId,
      name: 'Unpublished lifecycle target',
      id: ids.unpublished,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
      replayed: archiveBodies[0]?.replayed ?? false,
    });

    const replay = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json<LifecycleResponse>()).toEqual({
      replayed: true,
      workflow: acceptedArchive.workflow,
    });

    const mismatch = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 2 },
    });
    expectProblem(mismatch, 409, 'request.idempotency_conflict');

    const restored = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.unpublished, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-restore',
      }),
      payload: { expectedLifecycleRevision: 2 },
    });
    expectLifecycleResponse(restored, {
      workspaceId,
      name: 'Unpublished lifecycle target',
      id: ids.unpublished,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
      replayed: false,
    });

    const replayAfterRestore = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(replayAfterRestore.statusCode).toBe(202);
    expect(replayAfterRestore.json<LifecycleResponse>()).toEqual({
      replayed: true,
      workflow: acceptedArchive.workflow,
    });
    expect(await fixture.readLifecycle(ids.unpublished)).toEqual({
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      publishedVersionId: null,
    });

    const beforeNoop = await fixture.readHistory(ids.unpublished);
    const beforeNoopFacts = await lifecycleFacts(fixture, ids.unpublished);
    const noop = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.unpublished, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-noop',
      }),
      payload: { expectedLifecycleRevision: 3 },
    });
    expectLifecycleResponse(noop, {
      workspaceId,
      name: 'Unpublished lifecycle target',
      id: ids.unpublished,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.unpublished, beforeNoop);
    expect(await lifecycleFacts(fixture, ids.unpublished)).toEqual(
      beforeNoopFacts,
    );

    const stale = await application.inject({
      method: 'POST',
      url: path,
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-stale',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectProblem(stale, 409, 'workflow.lifecycle_conflict');
    expect(stale.json()).toMatchObject({ currentLifecycleRevision: 3 });
  });
}
