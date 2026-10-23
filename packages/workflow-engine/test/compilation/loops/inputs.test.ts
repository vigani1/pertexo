import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  executeNodeAttempt,
  verifyWorkflowExecutable,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  forEachGraph,
  nestedForEachGraph,
} from '../../support/executable-workflow.js';
import { structuredAttemptFixture } from '../../support/compilation/structured-attempt.js';

describe('For Each production operations', () => {
  it('resolves the nearest structured collection item', async () => {
    const {
      collection,
      declaredCollectionChecksum,
      executable,
      iterationPath,
    } = structuredAttemptFixture();
    let received: unknown;

    await expect(
      executeNodeAttempt({
        runId: 'run-foreach',
        nodeRunId: 'node-run-root',
        attemptId: 'attempt-root',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'body-first',
          iterationPath,
        }),
        nodeId: 'body-first',
        iterationPath,
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: 1,
          collection,
          collectionSize: 2,
          declaredCollectionChecksum,
        },
        runInput: { name: 'outer' },
        completedNodeOutputs: [],
        registry: {
          execute: (request) => {
            received = request.input;
            return Promise.resolve({
              kind: 'succeeded',
              output: request.input as never,
            });
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(received).toEqual({ value: { name: 'nearest' } });
  });
  it('rejects a tampered structured collection checksum', async () => {
    const { declaredCollectionChecksum, executable, iterationPath } =
      structuredAttemptFixture();

    await expect(
      executeNodeAttempt({
        runId: 'run-foreach',
        nodeRunId: 'node-run-tampered',
        attemptId: 'attempt-tampered',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'body-first',
          iterationPath,
        }),
        nodeId: 'body-first',
        iterationPath,
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: 1,
          collection: [{ name: 'first' }, { name: 'forged' }],
          collectionSize: 2,
          declaredCollectionChecksum,
        },
        runInput: { name: 'outer' },
        completedNodeOutputs: [],
        registry: {
          execute: () => Promise.resolve({ kind: 'succeeded', output: {} }),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });
  it('resolves the nearest item in a nested structured scope', async () => {
    const nestedExecutable = buildWorkflowExecutable({
      graph: nestedForEachGraph(),
      catalog: composeExecutableCatalog(nodeCatalog({ forEach: true })),
    });
    const nestedIterationPath = [
      { loopNodeId: 'loop', ordinal: 0 },
      { loopNodeId: 'body-first', ordinal: 1 },
    ] as const;
    const nestedCollection = ['inner-first', 'inner-nearest'] as const;
    await expect(
      executeNodeAttempt({
        runId: 'run-nested',
        nodeRunId: 'node-run-nested',
        attemptId: 'attempt-nested',
        executable: nestedExecutable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'nested-body',
          iterationPath: nestedIterationPath,
        }),
        nodeId: 'nested-body',
        iterationPath: nestedIterationPath,
        structuredCollection: {
          loopNodeId: 'body-first',
          ordinal: 1,
          collection: nestedCollection,
          collectionSize: 2,
          declaredCollectionChecksum: createHash('sha256')
            .update(JSON.stringify(nestedCollection))
            .digest('hex'),
        },
        runInput: { value: 'outer-run-input' },
        completedNodeOutputs: [],
        registry: {
          execute: (request) =>
            Promise.resolve({
              kind: 'succeeded',
              output: request.input as never,
            }),
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      output: { value: 'inner-nearest' },
    });
  });
  it.each(['__proto__', 'constructor', 'toString'])(
    'preserves reserved node and mapping IDs through compiled scoped execution: %s',
    async (reservedId) => {
      const graph = structuredClone(forEachGraph());
      const loop = graph.nodes.find(({ id }) => id === 'loop');
      if (loop === undefined || !('structured' in loop))
        throw new Error('For Each node missing');
      const source = loop.structured.body.nodes.find(
        ({ id }) => id === 'body-first',
      );
      const sink = loop.structured.body.nodes.find(
        ({ id }) => id === 'body-sink',
      );
      if (source === undefined || sink === undefined)
        throw new Error('body nodes missing');
      const edge = loop.structured.body.edges[0];
      if (edge === undefined) throw new Error('body edge missing');
      source.id = reservedId;
      edge.source.nodeId = reservedId;
      sink.inputMappings = {
        value: { kind: 'node_output', nodeId: reservedId, path: '$' },
      };

      const catalog = composeExecutableCatalog(nodeCatalog({ forEach: true }));
      const compiled = buildWorkflowExecutable({ graph, catalog });
      const compiledSink = compiled.envelope.graph.nodes
        .find(({ id }) => id === 'loop')
        ?.structured?.body.nodes.find(({ id }) => id === 'body-sink');
      expect(compiledSink?.inputMappings).toHaveProperty('value');
      const recovered = verifyWorkflowExecutable({
        envelope: JSON.parse(JSON.stringify(compiled.envelope)),
        checksum: compiled.checksum,
        catalog: catalog,
      });
      const recoveredSink = recovered.envelope.graph.nodes
        .find(({ id }) => id === 'loop')
        ?.structured?.body.nodes.find(({ id }) => id === 'body-sink');
      expect(recoveredSink?.inputMappings).toHaveProperty('value');
      const workflowVersionId = '00000000-0000-4000-8000-000000000001';
      const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }] as const;
      const collection = [{ name: 'nearest' }] as const;
      let received: unknown;

      await executeNodeAttempt({
        runId: 'run-reserved-ids',
        nodeRunId: 'node-run-reserved-ids',
        attemptId: 'attempt-reserved-ids',
        executable: recovered,
        workflowVersionId,
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'body-sink',
          iterationPath,
        }),
        nodeId: 'body-sink',
        iterationPath,
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: 0,
          collection,
          collectionSize: 1,
          declaredCollectionChecksum: createHash('sha256')
            .update(JSON.stringify(collection))
            .digest('hex'),
        },
        runInput: {},
        completedNodeOutputs: [
          {
            invocationKey: invocationKey({
              workflowVersionId,
              nodeId: reservedId,
              iterationPath,
            }),
            nodeId: reservedId,
            value: { exact: reservedId },
          },
        ],
        registry: {
          execute: (request) => {
            received = request.input;
            return Promise.resolve({ kind: 'succeeded', output: {} });
          },
        },
        signal: new AbortController().signal,
      });

      expect(Object.hasOwn(received as object, 'value')).toBe(true);
      expect((received as Record<string, unknown>).value).toEqual({
        exact: reservedId,
      });
    },
  );
});
