import { randomUUID } from 'node:crypto';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  createCheckpoint,
  parseCheckpoint,
  type WorkflowCheckpoint,
  type WorkflowCallOutcome,
} from '@pertexo/workflow-engine';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { catalog, collectionItems, type LoopScenario } from './scenarios.js';

/** Exercise the real engine and restart parser; only the provider/child facts are simulated. */
export async function* checkpoints(
  scenario: LoopScenario,
): AsyncGenerator<WorkflowCheckpoint> {
  const workflowVersionId = randomUUID();
  const executable = buildWorkflowExecutable({
    graph: scenario.graph,
    catalog,
  });
  const occurredAt = '2026-10-17T12:00:00.000Z';
  const base = {
    runId: randomUUID(),
    workflowVersionId,
    executable,
    occurredAt,
    maximumAdmissions: 10,
    signal: new AbortController().signal,
  };
  let plan = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpoint({
      workflowVersionId,
      iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
    }),
    observations: [],
  });
  let held: (typeof plan.attempts)[number] | undefined;
  let holdFirst = scenario.holdFirst === true;
  for (let transition = 0; transition < 30_000; transition++) {
    yield plan.checkpoint;
    if (plan.checkpoint.runStatus === 'succeeded') return;
    let sequence = plan.checkpoint.nextEventSequence;
    const observations = [];
    const completedOutputs = [];
    const attempts = [...plan.attempts];
    if (
      attempts.length === 0 &&
      !plan.immediateContinuation &&
      held !== undefined
    ) {
      attempts.push(held);
      held = undefined;
    }
    for (const attempt of attempts) {
      if (holdFirst && attempt.iterationPath?.[0]?.ordinal === 0) {
        held = attempt;
        holdFirst = false;
        continue;
      }
      const attemptId = randomUUID();
      observations.push({
        kind: 'outcome',
        sequence,
        occurredAt,
        invocationKey: attempt.invocationKey,
        attemptId,
        attemptNumber: attempt.attemptNumber,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      });
      const size = scenario.collections[attempt.nodeId];
      // About 255 KiB of retained collection data; the checkpoint must contain references only.
      let value;
      if (attempt.nodeId === scenario.parallelNodeId) {
        value = { branchIds: ['branch-01', 'branch-02'] };
      } else {
        if (attempt.nodeId === scenario.mergeNodeId) {
          value = {
            branches: { 'branch-01': {}, 'branch-02': {} },
            selectedBranchIds: ['branch-01', 'branch-02'],
          };
        } else {
          if (size === undefined) {
            value = {};
          } else {
            value = {
              items: collectionItems(size),
              iterationCount: size,
            };
          }
        }
      }
      completedOutputs.push({
        sequence,
        attemptId,
        invocationKey: attempt.invocationKey,
        value,
      });
      sequence++;
    }
    const waiting = plan.checkpoint.invocations.find(
      ({ waitKind }) => waitKind === 'workflow_call',
    );
    const callOutcomes: WorkflowCallOutcome[] =
      waiting === undefined
        ? []
        : [
            {
              callId: randomUUID(),
              invocationKey: waiting.invocationKey,
              nodeId: waiting.nodeId,
              status: 'succeeded',
              ...(waiting.branchPath === undefined
                ? {}
                : { branchPath: waiting.branchPath }),
              ...(waiting.iterationPath === undefined
                ? {}
                : { iterationPath: waiting.iterationPath }),
            },
          ];
    if (
      attempts.length === 0 &&
      !plan.immediateContinuation &&
      callOutcomes.length === 0
    )
      throw new Error(`Scenario stalled: ${scenario.name}`);
    plan = await advanceWorkflow({
      ...base,
      checkpoint: parseCheckpoint(JSON.parse(JSON.stringify(plan.checkpoint))),
      observations,
      completedOutputs,
      callOutcomes,
    });
  }
  throw new Error(`Scenario exceeded transition bound: ${scenario.name}`);
}
