import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  workflowPauseConflictProblemSchema,
  workflowAutoPauseSettingsConflictProblemSchema,
  workspaceAutoPauseSettingsConflictProblemSchema,
  type WorkflowAutoPauseCommandResponse,
  type WorkflowAutoPauseSettings,
} from '@pertexo/contracts';
import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  expectProblem,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../support/workflow-lifecycle.integration.support.js';

const integration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

integration('authenticated automatic pause HTTP controls (F26 slice 3)', () => {
  let fixture: WorkflowLifecycleApiFixture;
  beforeEach(async () => {
    fixture = await createWorkflowLifecycleApiFixture();
  });
  afterEach(async () => {
    await closeWorkflowLifecycleApiFixture(fixture);
  });

  function workflowPath() {
    return `/v1/workspaces/${fixture.workspaceId}/workflows/${fixture.ids.published}`;
  }

  async function pause(revision = '9007199254740993') {
    await fixture.withOwner(async (client) => {
      await client.query(
        `update app.workflows set trigger_pause_state='paused',
        trigger_paused_at=clock_timestamp(),trigger_pause_reason='consecutive_failures',
        trigger_pause_failures=10,trigger_pause_last_run_id=$2,trigger_pause_revision=$3::bigint
        where id=$1`,
        [fixture.ids.published, fixture.ids.run, revision],
      );
    });
  }

  it('requires session, CSRF, one key and strict bigint-string bodies', async () => {
    const owner = await fixture.login('owner');
    const url = `${workflowPath()}/resume`;
    const payload = { expectedPauseRevision: '1' };
    expectProblem(
      await fixture.application.inject({ method: 'POST', url, payload }),
      401,
      'auth.unauthenticated',
    );
    expectProblem(
      await fixture.application.inject({
        method: 'POST',
        url,
        payload,
        headers: {
          cookie: owner.cookieHeader,
          'idempotency-key': 'without-csrf',
        },
      }),
      403,
      'auth.forbidden',
    );
    for (const headers of [
      { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
      mutationHeaders(owner, { 'idempotency-key': 'first,second' }),
    ])
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url,
          payload,
          headers,
        }),
        400,
        'request.invalid',
      );
    for (const invalid of [
      { expectedPauseRevision: 1 },
      { expectedPauseRevision: '01' },
      { expectedPauseRevision: '9223372036854775808' },
      { ...payload, warning: true },
    ])
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url,
          payload: invalid,
          headers: mutationHeaders(owner),
        }),
        400,
        'request.invalid',
      );
  });

  it('lets a builder resume once and replay exactly without clearing a later pause', async () => {
    const builder = await fixture.login('builder');
    await pause();
    const url = `${workflowPath()}/resume`;
    const headers = mutationHeaders(builder, {
      'idempotency-key': 'resume-one',
    });
    const payload = { expectedPauseRevision: '9007199254740993' };
    const first = await fixture.application.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(first.statusCode, first.payload).toBe(200);
    const accepted = first.json<WorkflowAutoPauseCommandResponse>();
    expect(accepted).toMatchObject({
      replayed: false,
      settings: { pauseState: 'none', pauseRevision: '9007199254740994' },
    });
    await pause('9007199254740995');
    const replay = await fixture.application.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(replay.statusCode, replay.payload).toBe(200);
    expect(replay.json()).toEqual({ ...accepted, replayed: true });
    const current = await fixture.application.inject({
      method: 'GET',
      url: `${workflowPath()}/auto-pause`,
      headers: { cookie: builder.cookieHeader },
    });
    expect(current.json<WorkflowAutoPauseSettings>()).toMatchObject({
      pauseState: 'paused',
      pauseRevision: '9007199254740995',
    });
    const stalePause = await fixture.application.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(builder),
      payload,
    });
    expectProblem(stalePause, 409, 'workflow.pause_conflict');
    expect(
      workflowPauseConflictProblemSchema.parse(stalePause.json())
        .currentPauseRevision,
    ).toBe('9007199254740995');
    expectProblem(
      await fixture.application.inject({
        method: 'POST',
        url,
        headers,
        payload: { expectedPauseRevision: '9007199254740995' },
      }),
      409,
      'request.idempotency_conflict',
    );
    const audits = await fixture.withOwner(async (client) =>
      client.query<{ count: string }>(
        `select count(*)::text count from app.audit_events where target_id=$1 and action='workflow.triggers_resumed'`,
        [fixture.ids.published],
      ),
    );
    expect(audits.rows[0]?.count).toBe('1');
  });

  it('enforces workflow editing and owner-only default capabilities, and preserves independent revisions', async () => {
    const builder = await fixture.login('builder');
    const owner = await fixture.login('owner');
    const url = `${workflowPath()}/auto-pause`;
    const payload = {
      enabled: false,
      thresholdOverride: 3,
      expectedSettingsRevision: 1,
    };
    const accepted = await fixture.application.inject({
      method: 'PUT',
      url,
      headers: mutationHeaders(builder),
      payload,
    });
    expect(accepted.statusCode, accepted.payload).toBe(200);
    expect(accepted.json()).toMatchObject({
      settings: {
        enabled: false,
        thresholdOverride: 3,
        effectiveThreshold: 3,
        settingsRevision: 2,
        pauseRevision: '1',
      },
    });
    const staleSettings = await fixture.application.inject({
      method: 'PUT',
      url,
      headers: mutationHeaders(builder),
      payload,
    });
    expectProblem(staleSettings, 409, 'workflow.auto_pause_settings_conflict');
    expect(
      workflowAutoPauseSettingsConflictProblemSchema.parse(staleSettings.json())
        .currentSettingsRevision,
    ).toBe(2);
    for (const role of ['operator', 'viewer'] as const) {
      const cookies = await fixture.login(role);
      expectProblem(
        await fixture.application.inject({
          method: 'PUT',
          url,
          headers: mutationHeaders(cookies),
          payload,
        }),
        404,
        'resource.not_found',
      );
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url: `${workflowPath()}/resume`,
          headers: mutationHeaders(cookies),
          payload: { expectedPauseRevision: '1' },
        }),
        404,
        'resource.not_found',
      );
      expect(
        (
          await fixture.application.inject({
            method: 'GET',
            url,
            headers: { cookie: cookies.cookieHeader },
          })
        ).statusCode,
      ).toBe(200);
    }
    const defaults = `/v1/workspaces/${fixture.workspaceId}/auto-pause`;
    expectProblem(
      await fixture.application.inject({
        method: 'PUT',
        url: defaults,
        headers: mutationHeaders(builder),
        payload: { threshold: 12, expectedRevision: 1 },
      }),
      404,
      'resource.not_found',
    );
    const updated = await fixture.application.inject({
      method: 'PUT',
      url: defaults,
      headers: mutationHeaders(owner),
      payload: { threshold: 12, expectedRevision: 1 },
    });
    expect(updated.statusCode, updated.payload).toBe(200);
    expect(updated.json()).toMatchObject({
      settings: { threshold: 12, revision: 2 },
    });
    const staleDefault = await fixture.application.inject({
      method: 'PUT',
      url: defaults,
      headers: mutationHeaders(owner),
      payload: { threshold: 15, expectedRevision: 1 },
    });
    expectProblem(staleDefault, 409, 'workspace.auto_pause_settings_conflict');
    expect(
      workspaceAutoPauseSettingsConflictProblemSchema.parse(staleDefault.json())
        .currentRevision,
    ).toBe(2);
    const lifecycle = await fixture.readLifecycle(fixture.ids.published);
    expect(lifecycle).toMatchObject({
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
    });
    await fixture.setWorkspaceStatus('suspended');
    expectProblem(
      await fixture.application.inject({
        method: 'GET',
        url,
        headers: { cookie: owner.cookieHeader },
      }),
      404,
      'resource.not_found',
    );
  });
});
