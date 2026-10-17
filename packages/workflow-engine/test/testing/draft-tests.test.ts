import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approvalConfigSchema,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type AdvanceWorkflowInput,
  type WorkflowTestPins,
} from '../../src/index.js';
import {
  graph,
  nodeCatalog,
  forEachGraph,
} from '../support/executable-workflow.js';
import { callGraph, completion } from '../compilation/calls/fixtures.js';

function runtime(
  source: unknown,
  pins: WorkflowTestPins,
  options: Parameters<typeof nodeCatalog>[0] = {},
) {
  const catalog = composeExecutableCatalog(
    nodeCatalog({
      call: true,
      approval: true,
      inputRequest: true,
      forEach: true,
      condition: true,
      ...options,
    }),
  );
  const executable = buildWorkflowExecutable({ graph: source, catalog });
  const workflowVersionId = randomUUID();
  const test = { pinnedNodeIds: Object.keys(pins) };
  const advance = (
    checkpoint: unknown,
    extra: Partial<AdvanceWorkflowInput> = {},
  ) =>
    advanceWorkflow({
      executable,
      checkpoint,
      workflowVersionId,
      runId: randomUUID(),
      maximumAdmissions: 10,
      occurredAt: '2026-10-16T12:00:00.000Z',
      test,
      signal: new AbortController().signal,
      ...extra,
    });
  return {
    catalog,
    advance,
    initial: () =>
      advance(createCheckpoint({ workflowVersionId, iterationBudget: 200 })),
  };
}
const pin = (output: WorkflowTestPins[string]['output']) => ({
  sampleId: randomUUID(),
  output,
});

describe('whole-draft test policy', () => {
  it('removes provider keys from pinned idempotent steps while keeping ordinary writes keyed', async () => {
    for (const pinned of [true, false]) {
      const run = runtime(
        graph(),
        pinned ? { set: pin({ sample: true }) } : {},
        { setRetryClass: 'idempotent-with-key' },
      );
      const start = await run.initial();
      const step = await run.advance(start.checkpoint, completion(start));
      expect(step.attempts[0]?.nodeId).toBe('set');
      expect(step.attempts[0]?.sideEffectClass).toBe(
        pinned ? 'safe' : 'idempotent_with_key',
      );
      expect(step.nodeRunAdmissions[0]?.sideEffectClass).toBe(
        pinned ? 'safe' : 'idempotent_with_key',
      );
      if (pinned) {
        expect(step.attempts[0]?.providerIdempotencyKey).toBeUndefined();
        expect(
          step.nodeRunAdmissions[0]?.providerIdempotencyKey,
        ).toBeUndefined();
      } else {
        expect(step.attempts[0]?.providerIdempotencyKey).toEqual(
          expect.any(String),
        );
        expect(step.nodeRunAdmissions[0]?.providerIdempotencyKey).toBe(
          step.attempts[0]?.providerIdempotencyKey,
        );
      }
    }
  });

  it('uses a pinned Call result without declaring a child or blocking its successor', async () => {
    const run = runtime(callGraph(), { call: pin({ answer: 42 }) });
    const start = await run.initial();
    const call = await run.advance(start.checkpoint, completion(start));
    expect(call.attempts[0]?.nodeId).toBe('call');
    const next = await run.advance(
      call.checkpoint,
      completion(call, { answer: 42 }),
    );
    expect(next.callIntents ?? []).toEqual([]);
    expect(next.attempts.map((step) => step.nodeId)).toEqual(['terminate']);
    expect(
      next.checkpoint.invocations.find((step) => step.nodeId === 'call'),
    ).toMatchObject({ status: 'succeeded' });
  });
  it('treats a pinned For each result as final without running its body', async () => {
    const run = runtime(forEachGraph(), { loop: pin({ results: ['sample'] }) });
    const start = await run.initial();
    const loop = await run.advance(start.checkpoint, completion(start));
    const next = await run.advance(
      loop.checkpoint,
      completion(loop, { results: ['sample'] }),
    );
    expect(next.checkpoint.loops).toEqual([]);
    expect(next.attempts.map((step) => step.nodeId)).toEqual(['terminate']);
  });
  it('routes a pinned approval decision without opening a human task', async () => {
    const source = graph();
    const approval = parseWorkflowGraphDraft({
      ...source,
      nodes: source.nodes.map((node) =>
        node.id === 'set'
          ? {
              ...node,
              definition: { key: 'core.approval', version: 1 },
              config: approvalConfigSchema.parse({}),
              inputMappings: {},
            }
          : node,
      ),
      edges: source.edges.map((edge) =>
        edge.source.nodeId === 'set'
          ? { ...edge, source: { ...edge.source, port: 'approved' } }
          : edge,
      ),
    });
    const output = {
      selectedPort: 'approved',
      decision: 'approved',
      comment: 'Ready',
    };
    const run = runtime(approval, { set: pin(output) });
    const start = await run.initial();
    const step = await run.advance(start.checkpoint, completion(start));
    const next = await run.advance(step.checkpoint, completion(step, output));
    expect(next.taskIntents ?? []).toEqual([]);
    expect(next.attempts.map((step) => step.nodeId)).toEqual(['terminate']);
    expect(next.checkpoint.branchSelections[0]).toMatchObject({
      selectedOutputPort: 'approved',
    });
  });
  it('requires a valid branch selection before accepting pasted branch data', () => {
    const source = graph();
    const workflow = parseWorkflowGraphDraft({
      ...source,
      nodes: source.nodes.map((node) =>
        node.id === 'set'
          ? {
              ...node,
              definition: { key: 'core.approval', version: 1 },
              config: approvalConfigSchema.parse({}),
              inputMappings: {},
            }
          : node,
      ),
      edges: source.edges.map((edge) =>
        edge.source.nodeId === 'set'
          ? { ...edge, source: { ...edge.source, port: 'approved' } }
          : edge,
      ),
    });
    const catalog = runtime(workflow, {}).catalog;
    expect(
      buildWorkflowTestExecutable({
        graph: workflow,
        catalog,
        pins: { set: pin({ selectedPort: 'out' }) },
      }).invalidPinIds,
    ).toEqual(['set']);
    expect(
      buildWorkflowTestExecutable({
        graph: workflow,
        catalog,
        pins: { set: pin({ selectedPort: 'approved', comment: 'A sample' }) },
      }).invalidPinIds,
    ).toEqual([]);
  });
  it('charges only unpinned reachable-by-topology executors for real effects', () => {
    const source = parseWorkflowGraphDraft(forEachGraph());
    const catalog = composeExecutableCatalog(
      nodeCatalog({ forEach: true, setRetryClass: 'unsafe' }),
    );
    const ordinary = buildWorkflowTestExecutable({
      graph: source,
      catalog,
      pins: {},
    });
    expect(ordinary.effectfulNodeIds.sort()).toEqual([
      'body-first',
      'body-sink',
    ]);
    const pinned = buildWorkflowTestExecutable({
      graph: source,
      catalog,
      pins: { loop: pin({ results: [] }) },
    });
    expect(pinned.effectfulNodeIds).toEqual([]);
    expect(pinned.dispositions.loop).toBe('pinned');
    expect(pinned.initialCheckpoint(randomUUID()).nextEventSequence).toBe(2);
  });
});
