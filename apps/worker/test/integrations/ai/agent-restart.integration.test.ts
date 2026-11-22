import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import { AGENT_TOOL_LIMITS } from '@pertexo/workflow-model';

import { ContextKeyProvider } from '../../support/attempts/http-node-attempt/encryption.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { ServiceProcess } from '../../support/recovery/processes.js';
import { alias } from './agent.fixture.js';
import { startAgentRun } from './agent-run.fixture.js';
import type { AgentWorkerSettings } from './agent-worker.fixture.js';
import { chat, fakeModel, json } from './model.fixture.js';

const workerEntry = fileURLToPath(
  new URL('./agent-worker.fixture.ts', import.meta.url),
);
const timeoutMillis = 25_000;
const finalText = { text: 'Order a totals 42.' };
const finalAnswer = json({
  ...chat(finalText.text),
  usage: { prompt_tokens: 80, completion_tokens: 7 },
});
const hold: Parameters<typeof fakeModel>[0][number] = () => undefined;
const query = {
  filters: [{ column: 'key', operator: 'equals', value: 'a' }],
  limit: 1,
};
const proposal = json({
  usage: { prompt_tokens: 45, completion_tokens: 8 },
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        tool_calls: [
          {
            id: 'selected-order',
            type: 'function',
            function: { name: alias, arguments: JSON.stringify({ query }) },
          },
        ],
      },
    },
  ],
});

beforeAll(fixture.setup);
afterAll(fixture.restoreServicesAndClose);

describe('Agent restart', { timeout: 60_000 }, () => {
  it('charges both physical model requests when the first worker dies before completion', async () => {
    await using run = await start([hold, finalAnswer]);
    await run.waitForCalls(1);
    expect(await run.attempts()).toMatchObject([
      {
        status: 'running',
        side_effect_class: 'safe',
        dispatch_marked_at: expect.any(Date) as unknown,
      },
    ]);
    await run.restart();
    expect(await run.end()).toMatchObject({
      status: 'succeeded',
      output_ref: { value: finalText },
    });
    expect(run.calls).toHaveLength(2);
    expect(await run.checkpoint()).toMatchObject({
      phase: { kind: 'completion' },
      budget: {
        dispatches: 2,
        inputTokens: AGENT_TOOL_LIMITS.requestBytes + 80,
        outputTokens: AGENT_TOOL_LIMITS.outputTokens + 7,
      },
    });
    expect(await run.attempts()).toMatchObject([
      { status: 'failed' },
      { status: 'succeeded', output_ref: { value: finalText } },
    ]);
  });

  it('uses the committed proposal after a crash before Find rows runs', async () => {
    await using run = await start([proposal, finalAnswer], {
      pause: 'proposal',
    });
    await run.worker.waitForLog(/paused: proposal/u, timeoutMillis);
    expect(await run.checkpoint()).toMatchObject({
      phase: { kind: 'proposed_call' },
    });
    expect(await run.attempts()).toMatchObject([{ status: 'succeeded' }]);
    expect(run.calls).toHaveLength(1);
    await run.restart();
    await assertOneResult(run);
  });

  it('reclaims the dispatched safe Find rows attempt without another proposal', async () => {
    await using run = await start([proposal, finalAnswer], {
      deferWorker: true,
    });
    const pool = new pg.Pool({
      connectionString: fixture.databaseUrl(fixture.adminUrl),
      max: 1,
    });
    const lock = await pool.connect();
    try {
      await lock.query('begin');
      await lock.query(
        'lock table app.workspace_data_table_rows in access exclusive mode',
      );
      run.worker.startOnce();
      await fixture.waitFor(
        () =>
          lock.query<{ waiting: boolean }>(
            `select exists (select 1 from pg_locks
           where relation='app.workspace_data_table_rows'::regclass
           and database=(select oid from pg_database where datname=current_database())
           and not granted) as waiting`,
          ),
        ({ rows }) => rows[0]?.waiting === true,
        timeoutMillis,
      );
      expect(await run.attempts()).toMatchObject([
        { status: 'succeeded' },
        {
          status: 'running',
          side_effect_class: 'safe',
          dispatch_marked_at: expect.any(Date) as unknown,
        },
      ]);
      expect((await run.worker.stop('SIGKILL'))?.signal).toBe('SIGKILL');
    } finally {
      await lock.query('rollback');
      lock.release();
      await pool.end();
    }
    await run.restart();
    await assertOneResult(run);
    const attempts = await run.attempts();
    expect(attempts).toHaveLength(3);
    expect(attempts[1]?.fence_token).toBe('3');
  });

  it('consumes the committed Find rows receipt exactly once after restart', async () => {
    await using run = await start([proposal, finalAnswer], {
      pause: 'receipt',
    });
    await run.worker.waitForLog(/paused: receipt/u, timeoutMillis);
    expect(await run.checkpoint()).toMatchObject({
      phase: { kind: 'running_tool' },
    });
    expect(await run.attempts()).toMatchObject([
      { status: 'succeeded' },
      {
        status: 'succeeded',
        output_ref: { value: { rows: [{ values: { key: 'a', amount: 42 } }] } },
        completion_receipted: true,
      },
    ]);
    expect(run.calls).toHaveLength(1);
    await run.restart();
    await assertOneResult(run);
    expect(await run.checkpoint()).toMatchObject({
      phase: { kind: 'completion' },
      history: [
        expect.objectContaining({ output: expect.any(Object) as unknown }),
      ],
    });
    expect(await run.attempts()).toHaveLength(3);
  });

  it('ends with a typed budget failure after a restart and retains the completed read', async () => {
    // Two full reservations at this rate exceed the cost ceiling. The settled
    // first turn costs only its reported usage, so the second turn can dispatch once.
    const inputRate = 7_000;
    await using run = await start([proposal, hold], { inputRate });
    await run.waitForCalls(2);
    await run.restart();
    expect(await run.end()).toMatchObject({
      status: 'failed',
    });
    expect(run.calls).toHaveLength(2);
    expect(await run.failures()).toContainEqual({
      safe_error_code: 'agent.cost_limit',
    });
    expect(await run.checkpoint()).toMatchObject({
      budget: {
        dispatches: 2,
        estimatedCost: (45 + AGENT_TOOL_LIMITS.requestBytes) * inputRate,
      },
    });
    expect(await run.attempts()).toMatchObject([
      { status: 'succeeded' },
      {
        status: 'succeeded',
        output_ref: { value: { rows: [{ values: { key: 'a', amount: 42 } }] } },
      },
      { status: 'failed' },
    ]);
  });
});

async function assertOneResult(run: Awaited<ReturnType<typeof start>>) {
  expect(await run.end()).toMatchObject({
    status: 'succeeded',
    output_ref: { value: finalText },
  });
  expect(run.calls).toHaveLength(2);
  const { messages } = run.calls[1]?.request as {
    messages: { role: string; content: string }[];
  };
  const tools = messages.filter(({ role }) => role === 'tool');
  expect(tools).toHaveLength(1);
  expect(JSON.parse(tools[0]?.content ?? 'null')).toMatchObject({
    rows: [{ values: { key: 'a', amount: 42 } }],
  });
}

async function start(
  answers: Parameters<typeof fakeModel>[0],
  options: {
    pause?: AgentWorkerSettings['pause'];
    inputRate?: number;
    deferWorker?: boolean;
  } = {},
) {
  const provider = await fakeModel(answers);
  const key = randomBytes(32);
  const workerId = `agent-${randomUUID()}`;
  const makeWorker = (id: string, pause: AgentWorkerSettings['pause']) => {
    const settings: AgentWorkerSettings = {
      databaseUrl: fixture.databaseUrl(fixture.workerUrl),
      maintenanceUrl: fixture.databaseUrl(fixture.dispatcherUrl),
      redisUrl: fixture.redisUrl,
      key: key.toString('hex'),
      inputRate: options.inputRate ?? 0,
      workerId: id,
      ...(pause === undefined ? {} : { pause }),
    };
    return new ServiceProcess(workerEntry, {
      ...process.env,
      NODE_OPTIONS: '--import=tsx',
      AGENT_WORKER_FIXTURE: JSON.stringify(settings),
    });
  };
  const worker = makeWorker(workerId, options.pause);
  const replacement = makeWorker(`${workerId}-replacement`, undefined);
  const close = async () => {
    await Promise.all([worker.stop('SIGKILL'), replacement.stop('SIGKILL')]);
    await provider[Symbol.asyncDispose]();
  };
  try {
    const runId = await startAgentRun(
      provider.baseUrl,
      new ConnectionEnvelopeEncryption(new ContextKeyProvider(key)),
    );
    if (options.deferWorker !== true) worker.startOnce();
    return {
      worker,
      calls: provider.calls,
      waitForCalls: (count: number) =>
        fixture.waitFor(
          () => Promise.resolve(provider.calls.length),
          (actual) => actual >= count,
          timeoutMillis,
        ),
      async restart() {
        if (worker.alive)
          expect((await worker.stop('SIGKILL'))?.signal).toBe('SIGKILL');
        replacement.startOnce();
        await replacement.waitForLog(/Agent worker ready/u, timeoutMillis);
      },
      async end() {
        try {
          const rows = await fixture.waitFor(
            () =>
              fixture.workerQuery<{
                status: string;
                output_ref: unknown;
                error_summary: string | null;
              }>(
                'select status, output_ref, error_summary from app.workflow_runs where id=$1',
                [runId],
              ),
            ([row]) =>
              ['succeeded', 'failed', 'timed_out', 'outcome_unknown'].includes(
                row?.status ?? '',
              ),
            timeoutMillis,
          );
          return rows[0];
        } catch (error) {
          throw new Error(replacement.logs.map(({ text }) => text).join('\n'), {
            cause: error,
          });
        }
      },
      async checkpoint() {
        const [row] = await fixture.workerQuery<{ agent: unknown }>(
          "select scheduler_state->'agents'->0 as agent from app.run_checkpoints where workflow_run_id=$1",
          [runId],
        );
        return row?.agent;
      },
      failures: () =>
        fixture.workerQuery<{ safe_error_code: string }>(
          "select safe_error_code from app.node_runs where workflow_run_id=$1 and node_id='agent' and status='failed'",
          [runId],
        ),
      attempts: () =>
        fixture.workerQuery<{ status: string; fence_token: string }>(
          `select a.status, a.fence_token, a.side_effect_class, a.dispatch_marked_at, a.output_ref,
                exists (select 1 from app.outbox_events o join app.inbox_receipts r on r.message_id=o.id
                  where o.aggregate_id=a.id and o.job_name='execute-node-attempt' and r.completed_at is not null) as completion_receipted
           from app.node_attempts a join app.node_runs n on n.id=a.node_run_id
           where n.workflow_run_id=$1 and n.node_id='agent' order by a.started_at`,
          [runId],
        ),
      [Symbol.asyncDispose]: close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
