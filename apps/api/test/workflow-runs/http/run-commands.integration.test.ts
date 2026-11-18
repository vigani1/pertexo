import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRunFailureStore } from '@pertexo/core/runs';
import {
  parseDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';
import { apiBaseUrl } from '../../support/better-auth/api/stack.js';

let config: DatabaseConfig | undefined;
const api = useBetterAuthRealApi('run_refusals', {
  afterMigration: (url) => {
    config = parseDatabaseConfig({ connectionString: url(apiBaseUrl) });
    return Promise.resolve();
  },
});

type Reply = Readonly<{ statusCode: number; payload: string; json(): unknown }>;

function expectProblem(reply: Reply, status: number, code: string) {
  expect(reply.statusCode, reply.payload).toBe(status);
  expect(reply.json()).toMatchObject({ code });
}

/**
 * What each run command records, and what it answers when the run, the publication or the
 * workspace's run allowance says no, over real HTTP and PostgreSQL.
 */
describe.runIf(betterAuthIntegrationEnabled)('run commands over HTTP', () => {
  it('refuses unpublished, unknown, over-quota, unentitled and finished runs without writing one', async () => {
    const { browser, workspaceId, base, path, created } = await workflow();
    const start = () =>
      api.send('POST', `${path}/runs`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { input: {} },
      });
    const runCount = async () =>
      (
        await api
          .database()
          .query<{ count: number }>(
            'select count(*)::int count from app.workflow_runs where workspace_id=$1',
            [workspaceId],
          )
      ).rows[0]?.count;

    expectProblem(await start(), 409, 'workflow.not_published');
    expect(await runCount()).toBe(0);

    const versionId = await publish(browser, path, created.headers.etag);

    const unknown = `${base}/runs/${randomUUID()}`;
    expectProblem(
      await api.send('GET', unknown, { browser }),
      404,
      'resource.not_found',
    );
    expectProblem(
      await api.send('POST', `${unknown}/cancel`, {
        browser,
        payload: { reason: 'unknown run' },
      }),
      404,
      'resource.not_found',
    );
    expectProblem(
      await api.send('POST', `${unknown}/replay`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { workflowVersionId: versionId, input: {} },
      }),
      404,
      'resource.not_found',
    );

    const first = await start();
    expect(first.statusCode, first.payload).toBe(202);
    const runId = first.json<{ run: { id: string } }>().run.id;
    expectProblem(
      await api.send(
        'GET',
        `${base}/runs/${runId}/node-runs/${randomUUID()}/output`,
        { browser },
      ),
      404,
      'resource.not_found',
    );

    // The allowance is the workspace's entitlement: queued runs already at
    // its limit, then an entitlement that is no longer in effect.
    await api.database().query(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,1,'-infinity'::timestamptz),
             ($1,3,'suspended',5,100,'-infinity'::timestamptz)`,
      [workspaceId],
    );
    const entitlement = (version: number) =>
      api
        .database()
        .query(
          'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
          [workspaceId, version],
        );
    await entitlement(2);
    expectProblem(await start(), 429, 'workspace.quota_exceeded');
    await entitlement(3);
    expectProblem(await start(), 409, 'workspace.conflict');
    expect(await runCount()).toBe(1);
    await entitlement(1);

    await failRun(workspaceId, runId);
    expectProblem(
      await api.send('POST', `${base}/runs/${runId}/cancel`, {
        browser,
        payload: { reason: 'already finished' },
      }),
      409,
      'run.not_cancelable',
    );
  });
  it('records each command with its request identifiers, input, deadline and reason', async () => {
    const { browser, base, path, created } = await workflow();
    const versionId = await publish(browser, path, created.headers.etag);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
    const requestId = randomUUID();
    const started = await api.send('POST', `${path}/runs`, {
      browser,
      headers: {
        'idempotency-key': randomUUID(),
        'x-request-id': requestId,
        traceparent,
      },
      payload: { input: { customerId: 'customer-42' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    expect(await audit(runId, 'workflow.run.started')).toEqual({
      request_id: requestId,
      trace_id: traceId,
    });
    const input = await api.send('GET', `${base}/runs/${runId}/input`, {
      browser,
    });
    expect(input.json()).toEqual({
      input: { kind: 'inline', value: { customerId: 'customer-42' } },
    });

    const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const replayed = await api.send('POST', `${base}/runs/${runId}/replay`, {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        workflowVersionId: versionId,
        input: { customerId: 'customer-43' },
        deadlineAt,
      },
    });
    expect(replayed.statusCode, replayed.payload).toBe(202);
    const replayId = replayed.json<{ run: { id: string } }>().run.id;
    expect(await run(replayId)).toMatchObject({
      replay_source_run_id: runId,
      deadline_at: deadlineAt,
    });

    const canceled = await api.send('POST', `${base}/runs/${runId}/cancel`, {
      browser,
      headers: { traceparent },
      payload: { reason: 'operator request' },
    });
    expect(canceled.statusCode, canceled.payload).toBe(200);
    expect(await run(runId)).toMatchObject({
      cancel_reason: 'operator request',
      cancel_requested: true,
    });
    expect(await audit(runId, 'workflow.run.cancel_requested')).toMatchObject({
      trace_id: traceId,
    });

    const statistics = await api.send('GET', `${base}/run-statistics`, {
      browser,
    });
    expect(statistics.statusCode, statistics.payload).toBe(200);
    expect(statistics.json()).toMatchObject({ window: { duration: '24h' } });
  });
});

async function workflow() {
  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/login?verified=true');
  const browser = await api.signIn(email);
  const workspace = await api.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: { name: 'Run refusals', slug: `refusals-${randomUUID()}` },
  });
  expect(workspace.statusCode, workspace.payload).toBe(201);
  const workspaceId = workspace.json<{ id: string }>().id;
  const base = `/v1/workspaces/${workspaceId}`;
  const created = await api.send('POST', `${base}/workflows`, {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: { name: 'Run refusals' },
  });
  expect(created.statusCode, created.payload).toBe(201);
  const workflowId = created.json<{ workflow: { id: string } }>().workflow.id;
  const path = `${base}/workflows/${workflowId}`;
  return { browser, workspaceId, base, path, created };
}

async function publish(browser: Browser, path: string, etag: unknown) {
  const saved = await api.send('PUT', `${path}/draft`, {
    browser,
    headers: { 'if-match': String(etag) },
    payload: {
      graph: {
        settings: {},
        edges: [],
        nodes: [
          {
            id: randomUUID(),
            definition: { key: 'core.manual', version: 1 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            position: { x: 0, y: 0 },
          },
        ],
      },
    },
  });
  expect(saved.statusCode, saved.payload).toBe(200);
  const published = await api.send('POST', `${path}/publish`, {
    browser,
    headers: {
      'if-match': String(saved.headers.etag),
      'idempotency-key': randomUUID(),
    },
    payload: {},
  });
  expect(published.statusCode, published.payload).toBe(200);
  const versionId = published.json<{ version: { id: string } }>().version.id;
  return versionId;
}

async function audit(runId: string, action: string) {
  const rows = await api
    .database()
    .query<{ request_id: string | null; trace_id: string | null }>(
      'select request_id, trace_id from app.audit_events where target_id=$1 and action=$2',
      [runId, action],
    );
  return rows.rows[0];
}

async function run(runId: string) {
  const rows = await api.database().query<{
    replay_source_run_id: string | null;
    deadline_at: string | null;
    cancel_reason: string | null;
    cancel_requested: boolean;
  }>(
    `select replay_source_run_id, cancel_reason,
            to_char(deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') deadline_at,
            cancel_requested_by is not null cancel_requested
       from app.workflow_runs where id=$1`,
    [runId],
  );
  return rows.rows[0];
}

/** A worker isn't part of this: the run fails as the engine would fail it. */
async function failRun(workspaceId: string, runId: string) {
  if (config === undefined) throw new Error('Database fixture missing');
  const event = (
    await api
      .database()
      .query<{ id: string; payload_checksum: string }>(
        "select id,payload_checksum from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'",
        [runId],
      )
  ).rows[0];
  if (event === undefined) throw new Error('Advance delivery missing');
  await api
    .database()
    .query(
      `update app.run_checkpoints set scheduler_state=jsonb_set(scheduler_state,'{nextEventSequence}','"damaged"') where workflow_run_id=$1`,
      [runId],
    );
  const failures = createRunFailureStore(config);
  try {
    expect(
      await failures.failUnadvanceable({
        workspaceId,
        runId,
        expectedRevision: 0,
        safeErrorCode: 'execution.run_state_invalid',
        delivery: {
          outboxEventId: event.id,
          payloadChecksum: event.payload_checksum,
        },
        signal: new AbortController().signal,
      }),
    ).toBe('failed');
  } finally {
    await failures.close();
  }
}
