import { expect, it } from 'vitest';

import { expectProblem, mutationHeaders } from '../../lifecycle.support.js';
import {
  lifecyclePath,
  expectLifecycleResponse,
  expectHistoryUnchanged,
  lifecycleFacts,
  fixture,
} from './fixture.js';

export function registerArchivesRestoresPublishedWorkflowWithoutChanging(): void {
  it('archives and restores a published workflow without changing draft, version, or run history', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const before = await fixture.readHistory(ids.published);
    expect(before.runs).toEqual([
      {
        id: ids.run,
        status: 'succeeded',
        workflowVersionId: ids.publishedVersion,
      },
    ]);
    const beforeFacts = await lifecycleFacts(fixture, ids.published);

    const archive = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'archive'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-archive',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectLifecycleResponse(archive, {
      workspaceId,
      name: 'Published lifecycle target',
      id: ids.published,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      webhookSetupRequired: false,
      publishedVersionId: ids.publishedVersion,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.published, before);

    const afterArchiveFacts = await lifecycleFacts(fixture, ids.published);
    expect(afterArchiveFacts).toEqual({
      audit: beforeFacts.audit + 1,
      reconciliationOutbox: beforeFacts.reconciliationOutbox + 1,
    });

    const archiveRetry = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'archive'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-archive',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectLifecycleResponse(archiveRetry, {
      workspaceId,
      name: 'Published lifecycle target',
      id: ids.published,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      webhookSetupRequired: false,
      publishedVersionId: ids.publishedVersion,
      replayed: true,
    });
    expect(await lifecycleFacts(fixture, ids.published)).toEqual(
      afterArchiveFacts,
    );

    const restore = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-restore',
      }),
      payload: { expectedLifecycleRevision: 2 },
    });
    expectLifecycleResponse(restore, {
      workspaceId,
      name: 'Published lifecycle target',
      id: ids.published,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'activating',
      webhookSetupRequired: false,
      publishedVersionId: ids.publishedVersion,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.published, before);
    expect(await lifecycleFacts(fixture, ids.published)).toEqual({
      audit: beforeFacts.audit + 2,
      reconciliationOutbox: beforeFacts.reconciliationOutbox + 2,
    });

    const raceHeaders = [
      mutationHeaders(owner, { 'idempotency-key': 'published-cas-a' }),
      mutationHeaders(owner, { 'idempotency-key': 'published-cas-b' }),
    ];
    const beforeRace = await fixture.readHistory(ids.published);
    const beforeRaceFacts = await lifecycleFacts(fixture, ids.published);
    const race = await Promise.all(
      raceHeaders.map((headers) =>
        application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.published, 'archive'),
          headers,
          payload: { expectedLifecycleRevision: 3 },
        }),
      ),
    );
    expect(race.map(({ statusCode }) => statusCode).sort()).toEqual([202, 409]);
    const conflict = race.find(({ statusCode }) => statusCode === 409);
    if (conflict === undefined)
      throw new Error('CAS conflict response missing');
    expectProblem(conflict, 409, 'workflow.lifecycle_conflict');
    expect(conflict.json()).toMatchObject({ currentLifecycleRevision: 4 });
    await expectHistoryUnchanged(fixture, ids.published, beforeRace);
    expect(await lifecycleFacts(fixture, ids.published)).toEqual({
      audit: beforeRaceFacts.audit + 1,
      reconciliationOutbox: beforeRaceFacts.reconciliationOutbox + 1,
    });
  });
}
