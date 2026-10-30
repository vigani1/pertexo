import type { NodeManifest } from '@pertexo/node-sdk';
import type { StepRetrySettings } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  type WorkflowTransitionPlan,
} from '../../src/index.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';

const version = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const at = '2026-10-30T00:00:00.000Z';
const setKey = invocationKey({ workflowVersionId: version, nodeId: 'set' });

// docs/guides/step-retries.md: "A possibly dispatched unsafe operation stays
// `outcome_unknown` and is never called again automatically."
describe('coordinator retry decisions for possibly dispatched failures', () => {
  it('never retries a possibly dispatched unsafe step, even when the executor recommends retry', async () => {
    const run = await startedRun({ retryClass: 'unsafe' });
    const plan = await run.fail({
      attemptNumber: 1,
      errorKind: 'timeout',
      possiblyDispatched: true,
    });
    expect(setInvocation(plan)).toMatchObject({ status: 'outcome_unknown' });
    expect(setInvocation(plan)).not.toHaveProperty('waitKind');
    expect(plan.attempts).toEqual([]);
  });

  it('retries a possibly dispatched step whose provider call carries an idempotency key', async () => {
    const run = await startedRun({ retryClass: 'idempotent-with-key' });
    const plan = await run.fail({
      attemptNumber: 1,
      errorKind: 'timeout',
      possiblyDispatched: true,
    });
    expect(setInvocation(plan)).toMatchObject({
      status: 'waiting',
      waitKind: 'retry_backoff',
    });
  });
});

// docs/guides/step-retries.md: "Do not retry | One total try" and "Custom | Two
// to five total tries, with a fixed wait of 1–60 whole seconds".
describe('coordinator applies the published step retry settings', () => {
  it('stops at the first retryable failure for Do not retry', async () => {
    const run = await startedRun({
      retry: { maximumAttempts: 1, delayMillis: 1_000 },
    });
    const plan = await run.fail({ attemptNumber: 1, errorKind: 'network' });
    expect(setInvocation(plan)).toMatchObject({ status: 'failed' });
    expect(plan.checkpoint.runStatus).toBe('failed');
  });

  it('waits the fixed custom delay and keeps retrying past the platform default of three tries', async () => {
    const run = await startedRun({
      retry: { maximumAttempts: 5, delayMillis: 4_000 },
    });
    let plan = await run.fail({ attemptNumber: 1, errorKind: 'network' });
    for (let attempt = 2; attempt <= 3; attempt++) {
      const resumeAt = setInvocation(plan).resumeAt;
      expect(resumeAt).toBe(
        new Date(Date.parse(run.lastFailureAt()) + 4_000).toISOString(),
      );
      const resumed = await run.resume(resumeAt);
      expect(resumed.attempts).toMatchObject([
        { nodeId: 'set', attemptNumber: attempt },
      ]);
      plan = await run.fail({ attemptNumber: attempt, errorKind: 'network' });
    }
    expect(setInvocation(plan)).toMatchObject({
      status: 'waiting',
      waitKind: 'retry_backoff',
      resumeAt: new Date(Date.parse(run.lastFailureAt()) + 4_000).toISOString(),
    });
  });
});

async function startedRun({
  retryClass = 'safe',
  retry,
}: Readonly<{
  retryClass?: NodeManifest['retryClass'];
  retry?: StepRetrySettings;
}>) {
  const base = graph();
  const executable = buildWorkflowExecutable({
    graph: {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === 'set' && retry !== undefined ? { ...node, retry } : node,
      ),
    },
    catalog: composeExecutableCatalog(
      nodeCatalog({ setRetryClass: retryClass }),
    ),
  });
  let checkpoint: unknown = createCheckpoint({
    workflowVersionId: version,
    iterationBudget: 100,
  });
  let clock = Date.parse(at);
  let lastFailureAt = at;
  const step = async (observations: unknown, occurredAt: string) => {
    const plan = await advanceWorkflow({
      runId,
      executable,
      workflowVersionId: version,
      checkpoint,
      observations,
      occurredAt,
      maximumAdmissions: 5,
      signal: new AbortController().signal,
    });
    checkpoint = plan.checkpoint;
    return plan;
  };
  const tick = () => {
    clock += 1_000;
    return new Date(clock).toISOString();
  };
  const started = await step([], at);
  await step(
    [
      {
        sequence: started.checkpoint.nextEventSequence,
        occurredAt: at,
        kind: 'outcome',
        invocationKey: invocationKey({
          workflowVersionId: version,
          nodeId: 'manual',
        }),
        status: 'succeeded',
        output: { kind: 'inline', attemptId: runId },
        attemptId: runId,
        attemptNumber: 1,
      },
    ],
    at,
  );
  return {
    async fail(
      failure: Readonly<{
        attemptNumber: number;
        errorKind: string;
        possiblyDispatched?: boolean;
      }>,
    ) {
      lastFailureAt = tick();
      return step(
        [
          {
            occurredAt: lastFailureAt,
            kind: 'attempt_failure',
            invocationKey: setKey,
            attemptId: runId,
            attemptNumber: failure.attemptNumber,
            failureKind: 'retry',
            errorKind: failure.errorKind,
            possiblyDispatched: failure.possiblyDispatched ?? false,
            safeErrorCode: `execution.${failure.errorKind}`,
          },
        ],
        lastFailureAt,
      );
    },
    async resume(resumeAt: string | undefined) {
      if (resumeAt === undefined) throw new Error('The retry has no due time');
      clock = Date.parse(resumeAt);
      return step(
        [{ kind: 'due_at', occurredAt: resumeAt, invocationKey: setKey }],
        resumeAt,
      );
    },
    lastFailureAt: () => lastFailureAt,
  };
}

function setInvocation(plan: WorkflowTransitionPlan) {
  const invocation = plan.checkpoint.invocations.find(
    ({ nodeId }) => nodeId === 'set',
  );
  if (invocation === undefined) throw new Error('The set step never started');
  return invocation;
}
