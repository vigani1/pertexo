import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  invocationKey,
} from '../../../src/index.js';
import {
  forEachGraph,
  nodeCatalog,
} from '../../support/executable-workflow.js';
import { startForEach } from '../../support/compilation/for-each.js';

describe('For Each production operations', () => {
  it('rejects tampered loop topology, budget, and scope', async () => {
    const { base, control, declared, firstRoot } = await startForEach();

    const refunded = structuredClone(declared.checkpoint);
    Object.assign(refunded, { remainingIterationBudget: 1 });
    await expect(
      advanceWorkflow({ ...base, checkpoint: refunded, observations: [] }),
    ).rejects.toMatchObject({ code: 'checkpoint_invalid' });

    const tamperedTopology = structuredClone(declared.checkpoint);
    Object.assign(tamperedTopology.loops[0] ?? {}, {
      bodySinkNodeId: 'body-first',
    });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: tamperedTopology,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    const tamperedBounds = structuredClone(declared.checkpoint);
    Object.assign(tamperedBounds.loops[0] ?? {}, { maxConcurrency: 2 });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: tamperedBounds,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const bodyOutsideLoop = structuredClone(declared.checkpoint);
    const unscopedBody = bodyOutsideLoop.invocations.find(
      ({ invocationKey: key }) => key === firstRoot.invocationKey,
    );
    if (unscopedBody === undefined) throw new Error('body root missing');
    const unscopedBodyKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: unscopedBody.nodeId,
    });
    Object.assign(unscopedBody, { invocationKey: unscopedBodyKey });
    Reflect.deleteProperty(unscopedBody, 'branchPath');
    Reflect.deleteProperty(unscopedBody, 'iterationPath');
    Object.assign(bodyOutsideLoop, {
      admittedInvocationKeys: bodyOutsideLoop.admittedInvocationKeys.map(
        (key) => (key === firstRoot.invocationKey ? unscopedBodyKey : key),
      ),
    });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: bodyOutsideLoop,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const wrongOrdinal = structuredClone(declared.checkpoint);
    const wrongOrdinalBody = wrongOrdinal.invocations.find(
      ({ invocationKey: key }) => key === firstRoot.invocationKey,
    );
    if (wrongOrdinalBody === undefined) throw new Error('body root missing');
    const undeclaredIterationPath = [{ loopNodeId: 'loop', ordinal: 1 }];
    const wrongOrdinalKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: wrongOrdinalBody.nodeId,
      iterationPath: undeclaredIterationPath,
    });
    Object.assign(wrongOrdinalBody, {
      invocationKey: wrongOrdinalKey,
      iterationPath: undeclaredIterationPath,
    });
    Object.assign(wrongOrdinal, {
      admittedInvocationKeys: wrongOrdinal.admittedInvocationKeys.map((key) =>
        key === firstRoot.invocationKey ? wrongOrdinalKey : key,
      ),
    });
    await expect(
      advanceWorkflow({ ...base, checkpoint: wrongOrdinal, observations: [] }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const scopedTopLevel = structuredClone(declared.checkpoint);
    const scopedControl = scopedTopLevel.invocations.find(
      ({ invocationKey: key }) => key === control.invocationKey,
    );
    if (scopedControl === undefined) throw new Error('control missing');
    const scopedControlKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: scopedControl.nodeId,
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    });
    Object.assign(scopedControl, {
      invocationKey: scopedControlKey,
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    });
    Object.assign(scopedTopLevel.loops[0] ?? {}, {
      controlInvocationKey: scopedControlKey,
    });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: scopedTopLevel,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
  });
  it('settles skipped loop bodies without attempts', async () => {
    const { afterManual, base, control } = await startForEach();

    const skippedGraph = structuredClone(forEachGraph());
    const skippedControl = skippedGraph.nodes.find(({ id }) => id === 'loop');
    if (skippedControl === undefined || !('structured' in skippedControl))
      throw new Error('For Each structure missing');
    for (const bodyNode of skippedControl.structured.body.nodes)
      Object.assign(bodyNode, { disabled: true });
    const skippedExecutable = buildWorkflowExecutable({
      graph: skippedGraph,
      catalog: composeExecutableCatalog(
        nodeCatalog({ forEach: true, setRetryClass: 'idempotent-with-key' }),
      ),
    });
    const skippedDeclaration = await advanceWorkflow({
      ...base,
      executable: skippedExecutable,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000112',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000112',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000112',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(skippedDeclaration.attempts).toEqual([]);
    const skippedSink = await advanceWorkflow({
      ...base,
      executable: skippedExecutable,
      checkpoint: skippedDeclaration.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(skippedSink.attempts).toEqual([]);
    const skippedSettled = await advanceWorkflow({
      ...base,
      executable: skippedExecutable,
      checkpoint: skippedSink.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(skippedSettled.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [1],
      completedPrefix: 1,
      terminalOrdinals: [],
    });
  });
});
