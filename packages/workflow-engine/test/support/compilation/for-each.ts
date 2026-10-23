import type { AdvanceWorkflowInput } from '../../../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';
import { forEachGraph, nodeCatalog } from '../executable-workflow.js';
export async function startForEach() {
  const executable = buildWorkflowExecutable({
    graph: forEachGraph(),
    catalog: composeExecutableCatalog(
      nodeCatalog({ forEach: true, setRetryClass: 'idempotent-with-key' }),
    ),
  });
  const base: Pick<
    AdvanceWorkflowInput,
    | 'runId'
    | 'executable'
    | 'workflowVersionId'
    | 'occurredAt'
    | 'maximumAdmissions'
    | 'signal'
  > = {
    runId: 'run-foreach',
    executable,
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    occurredAt: '2026-08-24T10:00:00.000Z',
    maximumAdmissions: 1,
    signal: new AbortController().signal,
  } as const;
  const initial = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpoint({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 2,
    }),
    observations: [],
  });
  const manual = initial.attempts[0];
  if (manual === undefined) throw new Error('manual attempt missing');
  const afterManual = await advanceWorkflow({
    ...base,
    checkpoint: initial.checkpoint,
    observations: [
      {
        kind: 'outcome',
        sequence: initial.checkpoint.nextEventSequence,
        occurredAt: base.occurredAt,
        invocationKey: manual.invocationKey,
        attemptId: '00000000-0000-4000-8000-000000000101',
        attemptNumber: 1,
        status: 'succeeded',
        output: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000101',
        },
      },
    ],
    completedOutputs: [
      {
        sequence: initial.checkpoint.nextEventSequence,
        attemptId: '00000000-0000-4000-8000-000000000101',
        invocationKey: manual.invocationKey,
        value: {},
      },
    ],
  });
  const control = afterManual.attempts[0];
  if (control === undefined) throw new Error('For Each control missing');
  const declared = await advanceWorkflow({
    ...base,
    checkpoint: afterManual.checkpoint,
    observations: [
      {
        kind: 'outcome',
        sequence: afterManual.checkpoint.nextEventSequence,
        occurredAt: base.occurredAt,
        invocationKey: control.invocationKey,
        attemptId: '00000000-0000-4000-8000-000000000102',
        attemptNumber: 1,
        status: 'succeeded',
        output: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000102',
        },
      },
    ],
    completedOutputs: [
      {
        sequence: afterManual.checkpoint.nextEventSequence,
        attemptId: '00000000-0000-4000-8000-000000000102',
        invocationKey: control.invocationKey,
        value: { items: ['first', 'second'], iterationCount: 2 },
      },
      {
        sequence: afterManual.checkpoint.nextEventSequence,
        attemptId: '00000000-0000-4000-8000-000000000102',
        invocationKey: control.invocationKey,
        value: { items: ['first', 'second'], iterationCount: 2 },
      },
    ],
  });
  const firstRoot = declared.attempts[0];
  if (firstRoot === undefined) throw new Error('first body root missing');
  return { afterManual, base, control, declared, firstRoot };
}
