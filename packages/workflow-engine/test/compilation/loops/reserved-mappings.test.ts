import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { safeParseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  forEachGraph,
} from '../../support/executable-workflow.js';

describe('For Each production operations', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'preserves a reserved own mapping key without changing prototypes: %s',
    async (reservedKey) => {
      const graph = structuredClone(forEachGraph());
      const loop = graph.nodes.find(({ id }) => id === 'loop');
      if (loop === undefined || !('structured' in loop))
        throw new Error('For Each node missing');
      const sink = loop.structured.body.nodes.find(
        ({ id }) => id === 'body-sink',
      );
      if (sink === undefined) throw new Error('body sink missing');
      const mappings = Object.create(null) as Record<string, unknown>;
      mappings[reservedKey] = {
        kind: 'node_output',
        nodeId: 'body-first',
        path: '$',
      };
      sink.inputMappings = mappings as never;
      expect(Object.hasOwn(sink.inputMappings, reservedKey)).toBe(true);
      const parsedGraph = safeParseWorkflowGraphDraft(graph);
      expect(parsedGraph.success).toBe(true);
      if (!parsedGraph.success) throw parsedGraph.error;
      const parsedSink = parsedGraph.data.nodes
        .find(({ id }) => id === 'loop')
        ?.structured?.body.nodes.find(({ id }) => id === 'body-sink');
      expect(Object.keys(parsedSink?.inputMappings ?? {})).toContain(
        reservedKey,
      );

      const executable = buildWorkflowExecutable({
        graph,
        catalog: composeExecutableCatalog(nodeCatalog({ forEach: true })),
      });
      const compiledSink = executable.envelope.graph.nodes
        .find(({ id }) => id === 'loop')
        ?.structured?.body.nodes.find(({ id }) => id === 'body-sink');
      expect(
        Object.hasOwn(compiledSink?.inputMappings ?? {}, reservedKey),
      ).toBe(true);

      const workflowVersionId = '00000000-0000-4000-8000-000000000001';
      const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }] as const;
      const collection = [{ mapped: true }] as const;
      let received: unknown;
      await executeNodeAttempt({
        runId: 'run-reserved-key',
        nodeRunId: 'node-run-reserved-key',
        attemptId: 'attempt-reserved-key',
        executable,
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
              nodeId: 'body-first',
              iterationPath,
            }),
            nodeId: 'body-first',
            value: { safe: true },
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
      expect(Object.hasOwn(received as object, reservedKey)).toBe(true);
      expect(Reflect.get(received as object, reservedKey)).toEqual({
        safe: true,
      });
      expect(Reflect.get(Object.prototype, 'safe')).toBeUndefined();
    },
  );
});
