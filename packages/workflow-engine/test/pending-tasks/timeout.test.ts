import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  inputRequestConfigSchema,
  type JsonValue,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
  type AdvanceWorkflowInput,
  type PendingTaskOutcome,
  type WorkflowCheckpoint,
} from '../../src/index.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';
import { completion } from '../compilation/calls/fixtures.js';

const at = '2026-10-26T00:00:00.000Z';
type TaskKey = 'core.approval' | 'core.request_input';
type Link = readonly [port: string, target: string];

/** Manual → the task step → one Stop per linked target. */
function taskWorkflow(
  key: TaskKey,
  config: Readonly<Record<string, JsonValue>>,
  links: readonly Link[],
): WorkflowGraph {
  const base = graph();
  const targets = [...new Set(links.map(([, target]) => target))];
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'task',
        definition: { key, version: 1 },
        config:
          key === 'core.request_input'
            ? { ...inputRequestConfigSchema.parse({}), ...config }
            : config,
        inputMappings: {},
      },
      ...targets.map((id) => ({ ...base.nodes[2], id, inputMappings: {} })),
    ],
    edges: [
      {
        id: 'start',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'task', port: 'in' },
      },
      ...links.map(([port, target]) => ({
        id: `${port}-${target}`,
        source: { nodeId: 'task', port },
        target: { nodeId: target, port: 'in' },
      })),
    ],
  };
}

function compile(workflow: WorkflowGraph) {
  return buildWorkflowExecutable({
    graph: workflow,
    catalog: composeExecutableCatalog(
      nodeCatalog({ approval: true, inputRequest: true }),
    ),
  });
}

async function waitingTask(
  key: TaskKey,
  config: Readonly<Record<string, JsonValue>>,
  links: readonly Link[],
) {
  const version = randomUUID();
  const executable = compile(taskWorkflow(key, config, links));
  const advance = (
    checkpoint: WorkflowCheckpoint,
    extra: Partial<AdvanceWorkflowInput> = {},
  ) =>
    advanceWorkflow({
      workflowVersionId: version,
      runId: randomUUID(),
      executable,
      checkpoint,
      occurredAt: at,
      maximumAdmissions: 10,
      signal: new AbortController().signal,
      ...extra,
    });
  const initial = await advance(
    createCheckpoint({ workflowVersionId: version, iterationBudget: 200 }),
  );
  const prepared = await advance(initial.checkpoint, completion(initial));
  const waiting = await advance(
    prepared.checkpoint,
    completion(prepared, { pending: true }),
  );
  const owner = waiting.checkpoint.invocations.find(
    ({ nodeId }) => nodeId === 'task',
  );
  if (owner === undefined) throw new Error('Task step missing');
  const fact = (status: PendingTaskOutcome['status']): PendingTaskOutcome => ({
    taskId,
    nodeId: owner.nodeId,
    invocationKey: owner.invocationKey,
    status,
  });
  const taskId = randomUUID();
  return { advance, waiting, fact };
}

const approvalLinks: readonly Link[] = [
  ['approved', 'ship'],
  ['rejected', 'refund'],
  ['timed_out', 'escalate'],
];
const continues = { onExpiry: 'continue' } as const;

function statusOf(checkpoint: WorkflowCheckpoint, nodeId: string) {
  return checkpoint.invocations.find((owner) => owner.nodeId === nodeId)
    ?.status;
}

describe('an Approval that continues on Timed out', () => {
  it('settles an expired task as a success and runs only the Timed out path', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.approval',
      continues,
      approvalLinks,
    );
    const expired = await advance(waiting.checkpoint, {
      taskOutcomes: [fact('expired')],
    });
    expect(expired.attempts.map(({ nodeId }) => nodeId)).toEqual(['escalate']);
    expect(expired.events).toContainEqual(
      expect.objectContaining({
        name: 'node.succeeded',
        nodeId: 'task',
        reasonCode: 'pending_task.timed_out',
      }),
    );
    expect(
      expired.checkpoint.invocations.find(({ nodeId }) => nodeId === 'task')
        ?.output,
    ).toEqual({ kind: 'task', taskId: fact('expired').taskId });
    expect(statusOf(expired.checkpoint, 'ship')).toBe('skipped');
    expect(statusOf(expired.checkpoint, 'refund')).toBe('skipped');
    const finished = await advance(expired.checkpoint, completion(expired));
    expect(finished.checkpoint.runStatus).toBe('succeeded');
  });

  it.each(['approved', 'rejected'] as const)(
    'still follows %s when someone answers in time',
    async (status) => {
      const { advance, waiting, fact } = await waitingTask(
        'core.approval',
        continues,
        approvalLinks,
      );
      const decided = await advance(waiting.checkpoint, {
        taskOutcomes: [fact(status)],
      });
      expect(decided.attempts.map(({ nodeId }) => nodeId)).toEqual([
        status === 'approved' ? 'ship' : 'refund',
      ]);
      expect(statusOf(decided.checkpoint, 'escalate')).toBe('skipped');
    },
  );

  it('treats silence as approval when Timed out links to the Approved step', async () => {
    const links: readonly Link[] = [
      ['approved', 'ship'],
      ['rejected', 'refund'],
      ['timed_out', 'ship'],
    ];
    for (const [status, ran, skipped] of [
      ['expired', 'ship', 'refund'],
      ['approved', 'ship', 'refund'],
      ['rejected', 'refund', 'ship'],
    ] as const) {
      const { advance, waiting, fact } = await waitingTask(
        'core.approval',
        continues,
        links,
      );
      const next = await advance(waiting.checkpoint, {
        taskOutcomes: [fact(status)],
      });
      expect(next.attempts.map(({ nodeId }) => nodeId)).toEqual([ran]);
      expect(statusOf(next.checkpoint, skipped)).toBe('skipped');
      const finished = await advance(next.checkpoint, completion(next));
      expect(finished.checkpoint.runStatus).toBe('succeeded');
    }
  });

  it('still fails a capacity refusal, which is not a timeout', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.approval',
      continues,
      approvalLinks,
    );
    const refused = await advance(waiting.checkpoint, {
      taskOutcomes: [fact('refused')],
    });
    expect(refused.checkpoint.runStatus).toBe('failed');
    expect(refused.attempts).toEqual([]);
    expect(refused.events).toContainEqual(
      expect.objectContaining({
        name: 'node.failed',
        reasonCode: 'pending_task.capacity_exceeded',
      }),
    );
  });

  it('keeps cancellation authoritative over a later expiry', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.approval',
      continues,
      approvalLinks,
    );
    const canceled = await advance(waiting.checkpoint, {
      observations: [
        {
          kind: 'cancel_requested',
          sequence: waiting.checkpoint.nextEventSequence,
          occurredAt: at,
        },
      ],
    });
    expect(canceled.checkpoint.runStatus).toBe('canceled');
    const late = await advance(canceled.checkpoint, {
      taskOutcomes: [fact('expired')],
    });
    expect(late.events).toEqual([]);
    expect(late.attempts).toEqual([]);
    expect(late.checkpoint.runStatus).toBe('canceled');
  });

  it('does not let a late decision revive a timed-out task', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.approval',
      continues,
      approvalLinks,
    );
    const expired = await advance(waiting.checkpoint, {
      taskOutcomes: [fact('expired')],
    });
    const late = await advance(expired.checkpoint, {
      taskOutcomes: [fact('approved')],
    });
    expect(late.events).toEqual([]);
    expect(late.attempts).toEqual([]);
    expect(statusOf(late.checkpoint, 'ship')).toBe('skipped');
    await expect(
      advance(expired.checkpoint, {
        taskOutcomes: [{ ...fact('approved'), taskId: randomUUID() }],
      }),
    ).rejects.toThrow(/identity/u);
  });

  it('settles the same expiry once across a restart', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.approval',
      continues,
      approvalLinks,
    );
    // A crash before commit replays the advance from the stored checkpoint.
    const stored = () =>
      parseCheckpoint(JSON.parse(JSON.stringify(waiting.checkpoint)));
    const first = await advance(stored(), { taskOutcomes: [fact('expired')] });
    const replayed = await advance(stored(), {
      taskOutcomes: [fact('expired')],
    });
    expect(replayed.events).toEqual(first.events);
    expect(replayed.checkpoint.branchSelections).toEqual(
      first.checkpoint.branchSelections,
    );
    // After commit the unconsumed fact is read again and changes nothing.
    const again = await advance(
      parseCheckpoint(JSON.parse(JSON.stringify(first.checkpoint))),
      { taskOutcomes: [fact('expired')] },
    );
    expect(again.events).toEqual([]);
    expect(again.attempts).toEqual([]);
  });
});

describe('an Approval saved before Timed out existed', () => {
  it.each([{}, { onExpiry: 'fail' }])(
    'keeps failing its step on expiry (setup %j)',
    async (config) => {
      const { advance, waiting, fact } = await waitingTask(
        'core.approval',
        config,
        [
          ['approved', 'ship'],
          ['rejected', 'refund'],
        ],
      );
      const expired = await advance(waiting.checkpoint, {
        taskOutcomes: [fact('expired')],
      });
      expect(expired.checkpoint.runStatus).toBe('failed');
      expect(expired.attempts).toEqual([]);
      expect(expired.events).toContainEqual(
        expect.objectContaining({
          name: 'node.failed',
          reasonCode: 'pending_task.expired',
        }),
      );
    },
  );

  it('cannot publish a Timed out link it does not offer', () => {
    expect(() =>
      compile(
        taskWorkflow('core.approval', {}, [
          ['approved', 'ship'],
          ['timed_out', 'escalate'],
        ]),
      ),
    ).toThrow(/source port is not configured/u);
  });
});

describe('a Request input that continues on Timed out', () => {
  const links: readonly Link[] = [
    ['out', 'reply'],
    ['timed_out', 'escalate'],
  ];

  it('continues through Output once answered', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.request_input',
      continues,
      links,
    );
    const submitted = await advance(waiting.checkpoint, {
      taskOutcomes: [fact('submitted')],
    });
    expect(submitted.attempts.map(({ nodeId }) => nodeId)).toEqual(['reply']);
    expect(statusOf(submitted.checkpoint, 'escalate')).toBe('skipped');
  });

  it('continues through Timed out when nobody answers', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.request_input',
      continues,
      links,
    );
    const expired = await advance(waiting.checkpoint, {
      taskOutcomes: [fact('expired')],
    });
    expect(expired.attempts.map(({ nodeId }) => nodeId)).toEqual(['escalate']);
    expect(statusOf(expired.checkpoint, 'reply')).toBe('skipped');
    const finished = await advance(expired.checkpoint, completion(expired));
    expect(finished.checkpoint.runStatus).toBe('succeeded');
  });

  it('runs every Output link without branching when it fails on expiry', async () => {
    const { advance, waiting, fact } = await waitingTask(
      'core.request_input',
      {},
      [
        ['out', 'reply'],
        ['out', 'archive'],
      ],
    );
    const submitted = await advance(waiting.checkpoint, {
      taskOutcomes: [fact('submitted')],
    });
    expect(submitted.attempts.map(({ nodeId }) => nodeId).sort()).toEqual([
      'archive',
      'reply',
    ]);
    expect(submitted.checkpoint.branchSelections).toEqual([]);
  });
});
