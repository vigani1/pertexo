import { expect, it } from 'vitest';
import { inputRequestConfigSchema } from '@pertexo/workflow-model';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { invocationKey } from '@pertexo/workflow-engine/server';
import { createNodeAttemptExecutionEngine } from '../../src/attempts/execution/engine.js';
import { fixture, compiledProjection } from './engine.fixture.js';
import { graph, VERSION_ID } from '../support/attempts/execution-engine.js';

it.each([
  ['out', ['out', 'timed_out']],
  ['timed_out', ['out', 'timed_out']],
  ['out', ['timed_out', 'out']],
  ['timed_out', ['timed_out', 'out']],
] as const)(
  'loads and executes the shared successor on %s with links %j',
  async (selected, ports) => {
    const base = graph();
    const { catalog, lease } = fixture('terminate');
    const task = {
      ...base.nodes[1],
      id: 'task',
      definition: { key: 'core.request_input', version: 1 },
      config: inputRequestConfigSchema.parse({ onExpiry: 'continue' }),
      inputMappings: {},
    };
    const successor = {
      ...base.nodes[1],
      definition: { key: 'core.set', version: 1 },
      inputMappings: {
        result: { kind: 'node_output', nodeId: 'task', path: '$' },
      },
    };
    const draft = {
      ...base,
      nodes: [base.nodes[0], task, successor],
      edges: [
        {
          id: 'start',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'task', port: 'in' },
        },
        ...ports.map((port, n) => ({
          id: `edge-${String(n)}`,
          source: { nodeId: 'task', port },
          target: { nodeId: 'terminate', port: 'in' },
        })),
      ],
    };
    const branchPath = [{ nodeId: 'task', outputPort: selected }];
    const prepared = createNodeAttemptExecutionEngine({ catalog }).prepare({
      lease: {
        ...lease,
        branchPath,
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'terminate',
          branchPath: [`task:${selected}`],
        }),
      },
      projection: compiledProjection(draft, catalog),
    });
    const sourceKey = invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'task',
    });
    expect(prepared.upstreamNodeOutputs).toEqual([
      { nodeId: 'task', invocationKey: sourceKey },
    ]);
    const value = { selected };
    await expect(
      prepared.execute({
        runInput: {},
        completedNodeOutputs: [
          { nodeId: 'task', invocationKey: sourceKey, value },
        ],
        control: { kind: 'none' },
        registry: createCoreNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded', output: { result: value } });
  },
);
