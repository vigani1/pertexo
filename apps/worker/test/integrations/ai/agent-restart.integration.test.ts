import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import { createPendingTaskStore } from '@pertexo/core/runs';
import { AGENT_TOOL_LIMITS } from '@pertexo/workflow-model';

import { ContextKeyProvider } from '../../support/attempts/http-node-attempt/encryption.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { cancelFixtureRun } from '../../support/coordinator/runs/control.js';
import { ServiceProcess } from '../../support/recovery/processes.js';
import { actor, alias, config, slackChannel } from './agent.fixture.js';
import { startAgentRun } from './agent-run.fixture.js';
import type { AgentWorkerSettings } from './agent-worker.fixture.js';
import { chat, fakeModel, json } from './model.fixture.js';
import { childGraph } from '../../runs/calls/calls.fixture.js';
import { graph as approvalGraph } from '../../runs/pending-tasks/pending-tasks-execution.fixture.js';
import { fakeAgentSlack } from './slack-agent.fixture.js';

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
const insertProposal = modelProposal({ values: { key: 'c', amount: 12 } });

function modelProposal(args: Record<string, unknown>) {
  return json({
    usage: { prompt_tokens: 45, completion_tokens: 8 },
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [
            {
              id: 'new-order',
              type: 'function',
              function: { name: alias, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
}

beforeAll(fixture.setup);
afterAll(fixture.restoreServicesAndClose);

describe('Agent callable workflows', () => {
  it('runs an explicitly allowed pinned workflow and gives the model its typed result', async () => {
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: { child: childGraph() },
      },
    );
    expect(await run.end()).toMatchObject({
      status: 'succeeded',
      output_ref: { value: finalText },
    });
    expect(await run.tasks()).toEqual([]);
    expect(await run.children()).toMatchObject([
      {
        status: 'succeeded',
        result_ref: { value: 'Order a!' },
      },
    ]);
    expect(run.calls[0]?.request).toMatchObject({
      tools: [
        {
          function: {
            parameters: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    expect(callableToolMessages(run)).toEqual(['Order a!']);
  });

  it('bounds callable results before adding them to model history', async () => {
    const child = childGraph();
    if (child.callable === undefined)
      throw new Error('Fixture child has no contract');
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: {
          child: {
            ...child,
            callable: {
              ...child.callable,
              resultType: {
                type: 'object',
                properties: [
                  {
                    name: 'rows',
                    required: true,
                    valueType: {
                      type: 'array',
                      items: { type: 'string' },
                      maxItems: 1,
                    },
                  },
                  {
                    name: 'summary',
                    required: true,
                    valueType: { type: 'string' },
                  },
                ],
              },
              result: {
                kind: 'literal',
                value: {
                  rows: [],
                  summary: 'x'.repeat(AGENT_TOOL_LIMITS.resultBytes),
                },
              },
            },
          },
        },
      },
    );
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(await run.children()).toMatchObject([{ status: 'succeeded' }]);
    expect(callableToolMessages(run)).toEqual([{ truncated: true }]);
  });

  it('reports a failed callable child to the model as a typed outcome', async () => {
    const child = childGraph();
    if (child.callable === undefined)
      throw new Error('Fixture child has no contract');
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: {
          child: {
            ...child,
            callable: {
              ...child.callable,
              result: { kind: 'run_input', path: '$' },
            },
          },
        },
      },
    );
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(await run.children()).toMatchObject([
      { status: 'failed', result_ref: null },
    ]);
    expect(callableToolMessages(run)).toEqual([
      { status: 'failed', errorCode: 'callable_result_invalid' },
    ]);
  });

  it('stops the Agent when a callable write loses its receipt', async () => {
    await using slack = await fakeAgentSlack(true);
    const text = 'Order a is ready.';
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: { child: childGraph(), childSlackText: text },
        slackUrl: slack.baseUrl,
      },
    );
    expect(await run.end()).toMatchObject({ status: 'outcome_unknown' });
    expect(await run.children()).toMatchObject([
      { status: 'outcome_unknown', safe_error_code: 'execution.network' },
    ]);
    expect(await run.agentOutcomes()).toMatchObject([
      { status: 'outcome_unknown', safe_error_code: 'execution.network' },
    ]);
    expect(run.calls).toHaveLength(1);
    expect(slack.calls).toMatchObject([{ channel: slackChannel, text }]);
  });

  it('admits a callable child only after the Agent tool is approved', async () => {
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: { child: childGraph(), approval: true },
      },
    );
    const [task] = await fixture.waitFor(
      async () => {
        expect(await run.children()).toEqual([]);
        return run.tasks();
      },
      (rows) => rows[0]?.status === 'pending',
      timeoutMillis,
    );
    if (task === undefined) throw new Error('Agent approval is missing');
    expect(await run.attempts()).toMatchObject([{ status: 'succeeded' }]);
    expect(run.calls).toHaveLength(1);
    const tasks = createPendingTaskStore(config(fixture.apiUrl));
    try {
      await tasks.decide({
        ...actor,
        taskId: task.id,
        decision: 'approved',
        idempotencyKey: randomUUID(),
      });
    } finally {
      await tasks.close();
    }
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(callableToolMessages(run)).toEqual(['Order a!']);
    expect(await run.tasks()).toMatchObject([{ status: 'approved' }]);
    expect(await run.children()).toMatchObject([{ status: 'succeeded' }]);
  });

  it('cancels the waiting callable child when its Agent parent is canceled', async () => {
    await using run = await start([modelProposal({ name: 'Order a' })], {
      write: { child: childGraph(60) },
    });
    await waitForCallableChild(run);
    await cancelFixtureRun(run.id, 'Cancel while the callable tool waits');
    expect(await run.end()).toMatchObject({ status: 'canceled' });
    const [call] = await run.children();
    expect(call?.cancel_requested_at).toBeInstanceOf(Date);
    await fixture.waitFor(
      run.children,
      ([row]) => row?.status === 'canceled',
      timeoutMillis,
    );
    expect(run.calls).toHaveLength(1);
  });

  it('times out an Agent and its callable child during a human wait', async () => {
    await using run = await start([modelProposal({ name: 'Order a' })], {
      write: {
        child: { ...approvalGraph(), callable: childGraph().callable },
        timeoutMillis: 6_000,
      },
    });
    await waitForCallableChild(run);
    const [call] = await run.children();
    const [child] = await fixture.workerQuery<{ absolute_deadline_at: Date }>(
      'select absolute_deadline_at from app.workflow_runs where id=$1',
      [call?.child_run_id],
    );
    expect(await run.checkpoint()).toMatchObject({
      deadlineAt: call?.deadline_at?.toISOString(),
    });
    expect(child?.absolute_deadline_at).toEqual(call?.deadline_at);
    expect(await run.end()).toMatchObject({ status: 'timed_out' });
    expect(await run.children()).toMatchObject([{ status: 'timed_out' }]);
    expect(run.calls).toHaveLength(1);
  });

  it('consumes a waiting callable child once after a worker restart', async () => {
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: { child: childGraph(5) },
      },
    );
    await waitForCallableChild(run);
    const [original] = await run.children();
    expect(run.calls).toHaveLength(1);
    await run.restart();
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(run.calls).toHaveLength(2);
    expect(callableToolMessages(run)).toEqual(['Order a!']);
    expect(await run.children()).toMatchObject([
      {
        child_run_id: original?.child_run_id,
        status: 'succeeded',
        consumed_at: expect.any(Date) as unknown,
      },
    ]);
  });

  it('refuses a callable target unpublished after the tool proposal', async () => {
    await using run = await start(
      [modelProposal({ name: 'Order a' }), finalAnswer],
      {
        write: { child: childGraph() },
        pause: 'proposal',
      },
    );
    await run.worker.waitForLog(/paused: proposal/u, timeoutMillis);
    await fixture.ownerQuery(
      `update app.workflows set published_version_id=null
       where id=(
         select d.target_workflow_id from app.workflow_version_dependencies d
         join app.workflow_runs r on r.workflow_version_id=d.parent_version_id
         where r.id=$1
       )`,
      [run.id],
    );
    await run.restart();
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(await run.children()).toMatchObject([
      { status: 'refused', child_run_id: null },
    ]);
    expect(callableToolMessages(run)).toEqual([
      { status: 'failed', errorCode: 'call_target_unavailable' },
    ]);
  });
});

it('publishes and runs the Agent failure edge with the failed model attempt evidence', async () => {
  await using run = await start([json({})], { shape: 'failure-handler' });
  expect(await run.end()).toMatchObject({ status: 'succeeded' });
  const [handler] = await fixture.workerQuery(
    "select n.status, a.output_ref from app.node_runs n join app.node_attempts a on a.id=n.current_attempt_id where n.workflow_run_id=$1 and n.node_id='handler'",
    [run.id],
  );
  expect(handler).toMatchObject({
    status: 'succeeded',
    output_ref: {
      value: {
        result: {
          nodeId: 'agent',
          attemptNumber: 1,
          safeErrorCode: 'model.invalid_response',
        },
      },
    },
  });
  const [failure] = await fixture.workerQuery(
    'select current_attempt_number, failure_handling from app.node_runs where workflow_run_id=$1 and failure_ref is not null',
    [run.id],
  );
  expect(failure).toMatchObject({
    current_attempt_number: 1,
    failure_handling: 'handled',
  });
  expect(run.calls).toHaveLength(1);
});

it('collects each iteration result with Agent as the only For Each body step', async () => {
  const texts = ['alpha', 'beta', 'gamma'];
  await using run = await start(
    texts.map((text) =>
      json({
        ...chat(text),
        usage: { prompt_tokens: 8, completion_tokens: 1 },
      }),
    ),
    { shape: 'for-each' },
  );
  expect(await run.end()).toMatchObject({ status: 'succeeded' });
  const outputs = await fixture.workerQuery(
    "select output_ref from app.node_runs where workflow_run_id=$1 and node_id='agent' and current_attempt_id is null order by invocation_key",
    [run.id],
  );
  expect(outputs).toMatchObject(
    texts.map((text) => ({ output_ref: { value: { text } } })),
  );
});

describe('Agent restart', () => {
  it.each(['lost response', 'worker restart'] as const)(
    'stops for inspection after Slack dispatch following a %s',
    async (failure) => {
      await using slack = await fakeAgentSlack(failure === 'lost response');
      const text = 'Order c is ready.';
      await using run = await start([modelProposal({ text })], {
        write: 'slack',
        slackUrl: slack.baseUrl,
      });
      await fixture.waitFor(
        () => Promise.resolve(slack.calls.length),
        (count) => count > 0,
        timeoutMillis,
      );
      if (failure === 'worker restart') await run.restart();
      expect(await run.end()).toMatchObject({ status: 'outcome_unknown' });
      expect(await run.attempts()).toMatchObject([
        { status: 'succeeded' },
        {
          logical_status: 'outcome_unknown',
          side_effect_class: 'unsafe',
          dispatch_marked_at: expect.any(Date) as unknown,
        },
      ]);
      expect(slack.calls).toMatchObject([{ channel: slackChannel, text }]);
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.request).toMatchObject({
        tools: [
          {
            function: {
              parameters: {
                properties: { text: expect.any(Object) as unknown },
                additionalProperties: false,
              },
            },
          },
        ],
      });
      const request = run.calls[0]?.request as {
        tools: {
          function: { parameters: { properties: Record<string, unknown> } };
        }[];
      };
      expect(
        Object.keys(request.tools[0]?.function.parameters.properties ?? {}),
      ).toEqual(['text']);
    },
  );
  it('consumes one approval after restart and inserts the proposed row once', async () => {
    await using run = await start([insertProposal, finalAnswer], {
      write: 'approval',
    });
    const [task] = await fixture.waitFor(
      run.tasks,
      (rows) => rows[0]?.status === 'pending',
      timeoutMillis,
    );
    if (task === undefined) throw new Error('Agent approval is missing');
    expect(await run.checkpoint()).toMatchObject({
      phase: { kind: 'approval_wait' },
    });
    expect(await run.attempts()).toMatchObject([{ status: 'succeeded' }]);
    expect(run.calls).toHaveLength(1);
    await run.restart();
    const tasks = createPendingTaskStore(config(fixture.apiUrl));
    try {
      const command = {
        ...actor,
        taskId: task.id,
        decision: 'approved',
        idempotencyKey: randomUUID(),
      } as const;
      await tasks.decide(command);
      await tasks.decide(command);
    } finally {
      await tasks.close();
    }
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(await run.tasks()).toMatchObject([
      { status: 'approved', consumed_at: expect.any(Date) as unknown },
    ]);
    expect(await run.attempts()).toMatchObject([
      { status: 'succeeded' },
      {
        status: 'succeeded',
        output_ref: { value: { rows: [{ values: { key: 'c', amount: 12 } }] } },
      },
      { status: 'succeeded' },
    ]);
    expect(run.calls).toHaveLength(2);
  });

  it.each(['rejected', 'expired'] as const)(
    'reports a %s approval to the model without writing',
    async (decision) => {
      await using run = await start([insertProposal, finalAnswer], {
        write: 'approval',
      });
      const [task] = await fixture.waitFor(
        run.tasks,
        (rows) => rows[0]?.status === 'pending',
        timeoutMillis,
      );
      if (task === undefined) throw new Error('Agent approval is missing');
      if (decision === 'rejected') {
        const tasks = createPendingTaskStore(config(fixture.apiUrl));
        try {
          await tasks.decide({
            ...actor,
            taskId: task.id,
            decision,
            idempotencyKey: randomUUID(),
          });
        } finally {
          await tasks.close();
        }
      } else {
        await fixture.ownerQuery(
          'update app.pending_run_tasks set expires_at=statement_timestamp() where id=$1',
          [task.id],
        );
        await fixture.ownerQuery(
          'update app.node_runs set resume_at=statement_timestamp() where id=(select node_run_id from app.pending_run_tasks where id=$1)',
          [task.id],
        );
      }
      expect(await run.end()).toMatchObject({ status: 'succeeded' });
      expect(await run.attempts()).toHaveLength(2);
      const request = run.calls[1]?.request as {
        messages: { role: string; content: string }[];
      };
      expect(
        JSON.parse(
          request.messages.find(({ role }) => role === 'tool')?.content ??
            'null',
        ),
      ).toEqual({ approval: decision });
      expect(await run.tasks()).toMatchObject([
        { status: decision, consumed_at: expect.any(Date) as unknown },
      ]);
    },
  );

  it('cancels the pending approval without dispatching a write or another model turn', async () => {
    await using run = await start([insertProposal], { write: 'approval' });
    await fixture.waitFor(
      run.tasks,
      (rows) => rows[0]?.status === 'pending',
      timeoutMillis,
    );
    await cancelFixtureRun(run.id, 'Cancel before approval');
    expect(await run.end()).toMatchObject({ status: 'canceled' });
    expect(await run.tasks()).toMatchObject([
      { status: 'canceled', consumed_at: expect.any(Date) as unknown },
    ]);
    expect(await run.attempts()).toHaveLength(1);
    expect(run.calls).toHaveLength(1);
  });

  it('runs Insert row directly when publication allows the tool without approval', async () => {
    await using run = await start([insertProposal, finalAnswer], {
      write: 'allow',
    });
    expect(await run.end()).toMatchObject({ status: 'succeeded' });
    expect(await run.tasks()).toEqual([]);
    expect(await run.attempts()).toMatchObject([
      { status: 'succeeded' },
      {
        status: 'succeeded',
        output_ref: { value: { rows: [{ values: { key: 'c', amount: 12 } }] } },
      },
      { status: 'succeeded' },
    ]);
  });

  it('refuses invalid Slack input before opening a task or dispatching the tool', async () => {
    await using slack = await fakeAgentSlack(false);
    await using run = await start([modelProposal({ text: '' })], {
      write: 'slack',
      slackUrl: slack.baseUrl,
    });
    expect(await run.end()).toMatchObject({ status: 'failed' });
    expect(await run.failures()).toContainEqual({
      safe_error_code: 'agent.tool_arguments',
    });
    expect(await run.attempts()).toMatchObject([{ status: 'succeeded' }]);
    expect(await run.tasks()).toEqual([]);
    expect(slack.calls).toEqual([]);
  });

  it('refuses model arguments that try to change the published approval rule', async () => {
    await using run = await start(
      [
        modelProposal({
          values: { key: 'c', amount: 12 },
          writePermission: { kind: 'allow' },
        }),
      ],
      { write: 'approval' },
    );
    expect(await run.end()).toMatchObject({ status: 'failed' });
    expect(await run.failures()).toContainEqual({
      safe_error_code: 'agent.tool_arguments',
    });
    expect(await run.attempts()).toHaveLength(1);
    expect(await run.tasks()).toEqual([]);
    expect(run.calls[0]?.request).toMatchObject({
      tools: [
        {
          function: {
            parameters: {
              properties: { values: expect.any(Object) as unknown },
              additionalProperties: false,
            },
          },
        },
      ],
    });
  });
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

  it('commits the proposal with an inline sibling ready and resumes it after a crash', async () => {
    await using run = await start([proposal, finalAnswer], {
      pause: 'proposal',
      shape: 'sibling-set',
    });
    await run.worker.waitForLog(/paused: proposal/u, timeoutMillis);
    expect(await run.checkpoint()).toMatchObject({
      phase: { kind: 'proposed_call' },
    });
    expect(
      await fixture.workerQuery(
        `select status from app.node_runs
         where workflow_run_id=$1 and node_id='sibling'`,
        [run.id],
      ),
    ).toEqual([{ status: 'ready' }]);
    expect(await run.attempts()).toMatchObject([{ status: 'succeeded' }]);
    expect(run.calls).toHaveLength(1);
    await run.restart();
    await assertOneResult(run);
    expect(
      await fixture.workerQuery(
        `select a.fence_token::text as fence_token from app.node_attempts a
         join app.node_runs n on n.id=a.node_run_id
         where n.workflow_run_id=$1 and n.node_id='sibling'`,
        [run.id],
      ),
    ).toEqual([{ fence_token: '0' }]);
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

async function waitForCallableChild(run: Awaited<ReturnType<typeof start>>) {
  const [call] = await fixture.waitFor(
    run.children,
    ([row]) => row?.status === 'accepted' && row.child_status === 'waiting',
    timeoutMillis,
  );
  expect(call?.slot_lent).toBe(true);
  expect(await run.attempts()).toMatchObject([
    { status: 'succeeded' },
    { status: 'succeeded' },
  ]);
}

function callableToolMessages(run: Awaited<ReturnType<typeof start>>) {
  const { messages } = run.calls[1]?.request as {
    messages: { role: string; content: string }[];
  };
  return messages
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => JSON.parse(content) as unknown);
}

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
    write?: Parameters<typeof startAgentRun>[2];
    shape?: NonNullable<Parameters<typeof startAgentRun>[3]>['shape'];
    slackUrl?: string;
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
      ...(options.slackUrl === undefined ? {} : { slackUrl: options.slackUrl }),
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
      options.write,
      { shape: options.shape },
    );
    if (options.deferWorker !== true) worker.startOnce();
    return {
      id: runId,
      tasks: () =>
        fixture.workerQuery<{
          id: string;
          status: string;
          consumed_at: Date | null;
        }>(
          'select id, status, consumed_at from app.pending_run_tasks where run_id=$1',
          [runId],
        ),
      children: () =>
        fixture.workerQuery<{
          child_run_id: string | null;
          child_status: string | null;
          status: string;
          result_ref: unknown;
          safe_error_code: string | null;
          deadline_at: Date | null;
          cancel_requested_at: Date | null;
          consumed_at: Date | null;
          slot_lent: boolean;
        }>(
          `select c.child_run_id, r.status as child_status, c.status, c.result_ref, c.safe_error_code,
                  c.deadline_at, c.cancel_requested_at, c.consumed_at, c.slot_lent
           from app.workflow_calls c left join app.workflow_runs r
             on r.workspace_id=c.workspace_id and r.id=c.child_run_id
           where c.parent_run_id=$1`,
          [runId],
        ),
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
              [
                'succeeded',
                'failed',
                'timed_out',
                'outcome_unknown',
                'canceled',
              ].includes(row?.status ?? ''),
            timeoutMillis,
          );
          return rows[0];
        } catch (error) {
          throw new Error(
            [...worker.logs, ...replacement.logs]
              .map(({ text }) => text)
              .join('\n'),
            {
              cause: error,
            },
          );
        }
      },
      async checkpoint() {
        const [row] = await fixture.workerQuery<{ agent: unknown }>(
          "select scheduler_state->'agents'->0 as agent from app.run_checkpoints where workflow_run_id=$1",
          [runId],
        );
        return row?.agent;
      },
      agentOutcomes: () =>
        fixture.workerQuery(
          "select status, safe_error_code from app.node_runs where workflow_run_id=$1 and node_id='agent' and current_attempt_id is null",
          [runId],
        ),
      failures: () =>
        fixture.workerQuery<{ safe_error_code: string }>(
          "select safe_error_code from app.node_runs where workflow_run_id=$1 and node_id='agent' and status='failed'",
          [runId],
        ),
      attempts: () =>
        fixture.workerQuery<{ status: string; fence_token: string }>(
          `select a.status, n.status as logical_status, a.fence_token, a.side_effect_class, a.dispatch_marked_at, a.output_ref,
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
