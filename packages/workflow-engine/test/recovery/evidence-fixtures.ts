import type { WorkflowGraph } from '@pertexo/workflow-model';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  type CompiledWorkflowExecutable,
} from '../../src/server.js';
import type {
  RecoveryNode,
  RecoverySource,
} from '../../src/recovery/workflow-recovery.types.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';
import { id, record, source } from './recovery-workflow-fixtures.js';

// Valid recovery sources with one piece of evidence changed at a time.

export type Fixture = Readonly<{
  executable: CompiledWorkflowExecutable;
  source: RecoverySource;
}>;

export function withSource(
  fixture: Fixture,
  change: (source: RecoverySource) => RecoverySource,
): Fixture {
  return { ...fixture, source: change(fixture.source) };
}

/** Changes one retained step record, leaving the checkpoint as it was. */
export function patchRecord(
  fixture: Fixture,
  nodeId: string,
  patch: Partial<RecoveryNode>,
): Fixture {
  return withSource(fixture, (retained) => ({
    ...retained,
    nodes: retained.nodes.map((node) =>
      node.nodeId === nodeId ? { ...node, ...patch } : node,
    ),
  }));
}

/** Changes one checkpoint invocation, leaving the step records as they were. */
export function patchInvocation(
  fixture: Fixture,
  nodeId: string,
  patch: Readonly<Record<string, unknown>>,
): Fixture {
  const checkpoint = structuredClone(fixture.source.checkpoint);
  Object.assign(
    checkpoint.invocations.find((entry) => entry.nodeId === nodeId) ?? {},
    patch,
  );
  return withSource(fixture, (retained) => ({ ...retained, checkpoint }));
}

export function patchCheckpoint(
  fixture: Fixture,
  patch: Partial<RecoverySource['checkpoint']>,
): Fixture {
  return withSource(fixture, (retained) => ({
    ...retained,
    checkpoint: { ...retained.checkpoint, ...patch },
  }));
}

export const failedSet = (fixture: Fixture) => {
  const set = fixture.source.nodes.find((node) => node.nodeId === 'set');
  if (set === undefined) throw new Error('Recovery fixture lost its target');
  return set;
};

export function compile(routed: WorkflowGraph, options = {}) {
  return buildWorkflowExecutable({
    graph: routed,
    catalog: composeExecutableCatalog(nodeCatalog(options)),
  });
}

/** A step that never ran, as a disabled step is recorded. */
function skipped(executable: CompiledWorkflowExecutable, nodeId: string) {
  return {
    ...record(executable, { nodeId, ordinal: 4, status: 'succeeded' }),
    status: 'skipped' as const,
    currentAttemptId: null,
    currentAttemptNumber: null,
    attempts: [],
  };
}

/** manual -> set (disabled, so skipped) -> terminate, which failed. */
export function disabledPrefix(): Fixture {
  const base = graph();
  const executable = compile({
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === 'set' ? { ...node, disabled: true } : node,
    ),
  });
  return {
    executable,
    source: source([
      record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
      skipped(executable, 'set'),
      record(executable, { nodeId: 'terminate', ordinal: 3, status: 'failed' }),
    ]),
  };
}

/** manual -> Condition (disabled, so skipped) -> terminate, which failed. */
export function disabledCondition(): Fixture {
  const [manual, set, terminate] = graph().nodes;
  const executable = compile(
    {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        manual,
        {
          ...set,
          id: 'condition',
          disabled: true,
          definition: { key: 'core.condition', version: 1 },
          inputMappings: { condition: { kind: 'literal', value: true } },
        },
        { ...terminate, inputMappings: {} },
      ],
      edges: [
        {
          id: 'manual-condition',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'condition', port: 'in' },
        },
        {
          id: 'condition-terminate',
          source: { nodeId: 'condition', port: 'true' },
          target: { nodeId: 'terminate', port: 'in' },
        },
      ],
    },
    { condition: true },
  );
  return {
    executable,
    source: source([
      record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
      skipped(executable, 'condition'),
      record(executable, {
        nodeId: 'terminate',
        ordinal: 3,
        status: 'failed',
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
      }),
    ]),
  };
}

/** manual -> Condition -> yes-stop on true, no-stop on false. */
export function bothBranches(
  chosen: 'true' | 'false',
  failed: { nodeId: string; port: 'true' | 'false' },
  succeeded?: { nodeId: string; port: 'true' | 'false' },
): Fixture {
  const [manual, set, terminate] = graph().nodes;
  const executable = compile(
    {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        manual,
        {
          ...set,
          id: 'condition',
          definition: { key: 'core.condition', version: 1 },
          inputMappings: { condition: { kind: 'literal', value: true } },
        },
        { ...terminate, id: 'yes-stop', inputMappings: {} },
        { ...terminate, id: 'no-stop', inputMappings: {} },
      ],
      edges: [
        ['manual', 'out', 'condition'],
        ['condition', 'true', 'yes-stop'],
        ['condition', 'false', 'no-stop'],
      ].map(([from = '', port = '', to = '']) => ({
        id: `${from}-${port}`,
        source: { nodeId: from, port },
        target: { nodeId: to, port: 'in' },
      })),
    },
    { condition: true },
  );
  const condition = record(executable, {
    nodeId: 'condition',
    ordinal: 2,
    status: 'succeeded',
  });
  const retained = source([
    record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
    condition,
    ...(succeeded === undefined
      ? []
      : [
          record(executable, {
            nodeId: succeeded.nodeId,
            ordinal: 3,
            status: 'succeeded',
            branchPath: [{ nodeId: 'condition', outputPort: succeeded.port }],
          }),
        ]),
    record(executable, {
      nodeId: failed.nodeId,
      ordinal: 4,
      status: 'failed',
      branchPath: [{ nodeId: 'condition', outputPort: failed.port }],
    }),
  ]);
  return {
    executable,
    source: {
      ...retained,
      checkpoint: {
        ...retained.checkpoint,
        branchSelections: [
          {
            invocationKey: condition.invocationKey,
            nodeId: 'condition',
            selectedOutputPort: chosen,
          },
        ],
      },
    },
  };
}

export function reusedManual(
  fixture: Fixture,
  patch: Partial<RecoveryNode> = {},
) {
  return withSource(fixture, (retained) =>
    source(
      retained.nodes.map((node) =>
        node.nodeId !== 'manual'
          ? node
          : {
              ...node,
              currentAttemptId: null,
              currentAttemptNumber: null,
              completedAt: null,
              attempts: [],
              reused: {
                sourceRunId: id(500),
                sourceNodeRunId: id(501),
                completedAt: '2026-10-01T00:00:00.000Z',
              },
              ...patch,
            },
      ),
    ),
  );
}
