import { randomUUID } from 'node:crypto';
import { MIN_AUTO_PAUSE_THRESHOLD } from '@pertexo/policy';
import { HttpPollFailure } from '@pertexo/workflow-model';
import { beforeEach, expect, it, onTestFinished } from 'vitest';
import type { FetchPoll } from '../../../src/triggers/polling/items.js';
import { pollingFixture } from './polling.fixture.js';

let poll: ReturnType<typeof pollingFixture>;

beforeEach(async () => {
  poll = pollingFixture();
  onTestFinished(() => poll.close());
  await poll.initialize();
});

const feed =
  (...keys: string[]): FetchPoll =>
  () =>
    Promise.resolve(keys.map((key) => ({ key, item: { key } })));
const failure =
  (code: HttpPollFailure['code']): FetchPoll =>
  () =>
    Promise.reject(new HttpPollFailure(code));
const scope = () => ({
  workspaceId: poll.workspaceId,
  workflowId: poll.workflowId,
  actorId: poll.actorId,
});

it('pauses for lost authentication, audits the poll, and resumes the same position without a run', async () => {
  const { triggerId } = await poll.publish();
  await poll.scanner(feed('baseline'))();
  const baseline = (await poll.read(triggerId))?.hashes;
  await poll.makeDue(triggerId);
  const code = 'http.poll_authentication';
  expect(await poll.scanner(failure(code))()).toMatchObject({ paused: 1 });
  const settings = await poll.controls.readWorkflowSettings(scope());
  expect(settings).toMatchObject({
    pauseState: 'paused',
    pausedLastRunId: null,
    pausedFailures: 1,
    pauseEvidence: { kind: 'poll', triggerId, errorCode: code },
  });
  expect(await poll.admitted()).toEqual([]);
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: baseline,
    health: 'unhealthy',
    lastErrorCode: code,
  });
  const audit = await poll.ownerQuery(
    "select metadata from app.audit_events where target_id=$1 and action='workflow.triggers_paused'",
    [poll.workflowId],
  );
  expect(audit.rows).toEqual([
    {
      metadata: {
        reason: 'consecutive_failures',
        triggerId,
        errorCode: code,
        failures: 1,
        threshold: settings.effectiveThreshold,
      },
    },
  ]);
  const command = {
    ...scope(),
    idempotencyKey: randomUUID(),
    expectedPauseRevision: settings.pauseRevision,
  };
  const resumed = await poll.controls.resumeWorkflow(command);
  expect(resumed.settings.pauseState).toBe('none');
  expect(resumed.settings).not.toHaveProperty('pauseEvidence');
  expect(await poll.controls.resumeWorkflow(command)).toEqual({
    ...resumed,
    replayed: true,
  });
  expect((await poll.read(triggerId))?.hashes).toEqual(baseline);

  await poll.scanner(feed('new', 'baseline'))();
  expect(await poll.admitted()).toEqual([{ item: { key: 'new' }, outbox: 1 }]);
  expect(await poll.read(triggerId)).toMatchObject({
    health: 'healthy',
    lastErrorCode: null,
  });
});

it('uses the configured threshold, clears the streak after a valid fetch, and starts a new streak on resume', async () => {
  await poll.controls.updateWorkflowSettings({
    ...scope(),
    idempotencyKey: randomUUID(),
    enabled: true,
    thresholdOverride: MIN_AUTO_PAUSE_THRESHOLD,
    expectedSettingsRevision: 1,
  });
  const { triggerId, reconcile } = await poll.publish();
  const code = 'http.poll_invalid_items';
  const scanFailure = poll.scanner(failure(code));
  const scanSuccess = poll.scanner(feed());
  const next = async (scan: typeof scanFailure) => {
    await poll.makeDue(triggerId);
    return scan();
  };
  await scanFailure();
  expect(await poll.controls.readWorkflowSettings(scope())).toMatchObject({
    pauseState: 'none',
  });
  await reconcile();
  expect(await poll.read(triggerId)).toMatchObject({
    health: 'degraded',
    lastErrorCode: code,
  });
  await next(scanSuccess);
  expect(await poll.read(triggerId)).toMatchObject({
    health: 'healthy',
    lastErrorCode: null,
  });
  for (let index = 1; index < MIN_AUTO_PAUSE_THRESHOLD; index++) {
    await next(scanFailure);
    expect(await poll.controls.readWorkflowSettings(scope())).toMatchObject({
      pauseState: 'none',
    });
  }
  expect(await next(scanFailure)).toMatchObject({ paused: 1 });
  const paused = await poll.controls.readWorkflowSettings(scope());
  expect(paused).toMatchObject({
    pausedFailures: MIN_AUTO_PAUSE_THRESHOLD,
    pauseEvidence: { kind: 'poll', triggerId, errorCode: code },
  });
  await poll.controls.resumeWorkflow({
    ...scope(),
    idempotencyKey: randomUUID(),
    expectedPauseRevision: paused.pauseRevision,
  });
  await next(scanFailure);
  expect(await poll.controls.readWorkflowSettings(scope())).toMatchObject({
    pauseState: 'none',
  });
});

it('tracks a failing feed with auto-pause disabled and pauses when the workspace rule applies', async () => {
  const updated = await poll.controls.updateWorkspaceSettings({
    workspaceId: poll.workspaceId,
    actorId: poll.actorId,
    idempotencyKey: randomUUID(),
    threshold: MIN_AUTO_PAUSE_THRESHOLD,
    expectedRevision: 1,
  });
  expect(updated.settings.threshold).toBe(MIN_AUTO_PAUSE_THRESHOLD);
  const disabled = await poll.controls.updateWorkflowSettings({
    ...scope(),
    idempotencyKey: randomUUID(),
    enabled: false,
    thresholdOverride: null,
    expectedSettingsRevision: 1,
  });
  const { triggerId } = await poll.publish();
  const scan = poll.scanner(failure('http.poll_response_failed'));
  for (let index = 0; index < MIN_AUTO_PAUSE_THRESHOLD; index++) {
    await poll.makeDue(triggerId);
    expect(await scan()).toMatchObject({ paused: 0 });
  }
  expect(await poll.read(triggerId)).toMatchObject({
    health: 'degraded',
    lastErrorCode: 'http.poll_response_failed',
  });
  expect((await poll.controls.readWorkflowSettings(scope())).pauseState).toBe(
    'none',
  );
  await poll.controls.updateWorkflowSettings({
    ...scope(),
    idempotencyKey: randomUUID(),
    enabled: true,
    thresholdOverride: null,
    expectedSettingsRevision: disabled.settings.settingsRevision,
  });
  await poll.makeDue(triggerId);
  expect(await scan()).toMatchObject({ paused: 1 });
});

it('discards a late authentication failure after another lease has finished the check', async () => {
  const { triggerId } = await poll.publish();
  const fetching = Promise.withResolvers<undefined>();
  const reply = Promise.withResolvers<never>();
  const old = poll.scanner(() => {
    fetching.resolve(undefined);
    return reply.promise;
  })();
  await fetching.promise;
  try {
    await poll.ownerQuery(
      "update app.trigger_polls set lease_acquired_at=statement_timestamp()-interval '2 seconds', lease_expires_at=statement_timestamp()-interval '1 second' where trigger_id=$1",
      [triggerId],
    );
    await poll.scanner(feed('baseline'))();
  } finally {
    reply.reject(new HttpPollFailure('http.poll_authentication'));
  }
  expect(await old).toMatchObject({ deferred: 1, paused: 0 });
  expect(await poll.read(triggerId)).toMatchObject({
    health: 'healthy',
    lastErrorCode: null,
  });
  expect((await poll.controls.readWorkflowSettings(scope())).pauseState).toBe(
    'none',
  );
});
