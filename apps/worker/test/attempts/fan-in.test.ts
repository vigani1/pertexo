import { expect, it } from 'vitest';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { invocationKey } from '@pertexo/workflow-engine/server';
import { createNodeAttemptExecutionEngine } from '../../src/attempts/execution/engine.js';
import { fixture, compiledProjection } from './engine.fixture.js';
import { graph, VERSION_ID } from '../support/attempts/execution-engine.js';

it('executes a supported 100-way fan-in with individually legal stored outputs above one MiB in total', async () => {
  const base = graph();
  const template = base.nodes[1];
  if (template === undefined) throw new Error('Missing node fixture');
  const predecessors = Array.from({ length: 100 }, (_, n) => ({
    ...template,
    id: `source-${String(n)}`,
    definition: { key: 'core.set', version: 1 },
    inputMappings: {},
  }));
  const { catalog, lease } = fixture('terminate');
  const draft = {
    ...base,
    nodes: [
      base.nodes[0],
      ...predecessors,
      {
        ...template,
        definition: { key: 'core.set', version: 1 },
        inputMappings: {},
      },
    ],
    edges: predecessors.flatMap((source) => [
      {
        id: `start-${source.id}`,
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: source.id, port: 'in' },
      },
      {
        id: `end-${source.id}`,
        source: { nodeId: source.id, port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ]),
  };
  const prepared = createNodeAttemptExecutionEngine({ catalog }).prepare({
    lease,
    projection: compiledProjection(draft, catalog),
  });
  expect(prepared.upstreamNodeOutputs).toHaveLength(100);
  await expect(
    prepared.execute({
      runInput: {},
      completedNodeOutputs: predecessors.map((source) => ({
        nodeId: source.id,
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: source.id,
        }),
        value: { payload: 'x'.repeat(20_000) },
      })),
      control: { kind: 'none' },
      registry: createCoreNodeRegistry(),
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ kind: 'succeeded', output: {} });
});
