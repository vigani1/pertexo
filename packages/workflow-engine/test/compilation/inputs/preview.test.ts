import { describe, expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  executeNodeAttempt,
  invocationKey,
  resolveSingleNodePreviewInput,
} from '../../../src/index.js';
import {
  graph,
  nodeCatalog,
  completedOutputs,
} from '../../support/executable-workflow.js';
import {
  expressionEvaluator,
  mappedExecutable,
} from '../../support/compilation/input-resolution.js';

describe('input resolution production operations', () => {
  it('contains hostile registry and expression-evaluator rejections', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const expressionGraph = structuredClone(graph());
    Object.assign(expressionGraph.nodes[1], {
      inputMappings: {
        expression: {
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.value',
        },
      },
    });
    const expressionExecutable = buildWorkflowExecutable({
      graph: expressionGraph,
      catalog,
    });
    const throwingName = new Error('private registry message');
    Object.defineProperty(throwingName, 'name', {
      get() {
        throw new Error('secondary name failure');
      },
    });
    const prototypeTrap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('secondary prototype failure');
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const base = {
      runId: 'run-hostile',
      nodeRunId: 'node-run-hostile',
      attemptId: 'attempt-hostile',
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        nodeId: 'set',
      }),
      nodeId: 'set',
      runInput: { value: 1 },
      completedNodeOutputs: completedOutputs({ manual: {} }),
      signal: new AbortController().signal,
    } as const;
    for (const rejection of [throwingName, prototypeTrap, revoked.proxy])
      await expect(
        executeNodeAttempt({
          ...base,
          executable,
          registry: {
            // Exercises classification of hostile non-Error Promise rejections.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            execute: () => Promise.reject(rejection),
          },
        }),
      ).rejects.toMatchObject({
        code: 'attempt_invalid',
        message: 'node execution failed',
      });

    for (const rejection of [prototypeTrap, revoked.proxy]) {
      let registryCalls = 0;
      await expect(
        executeNodeAttempt({
          ...base,
          executable: expressionExecutable,
          expressionEvaluator: {
            // Exercises classification of hostile non-Error Promise rejections.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            evaluate: () => Promise.reject(rejection),
          },
          registry: {
            execute: () => {
              registryCalls += 1;
              return Promise.resolve({ kind: 'succeeded', output: {} });
            },
          },
        }),
      ).rejects.toMatchObject({
        code: 'attempt_invalid',
        message: 'mapping failed',
      });
      expect(registryCalls).toBe(0);
    }
  });
  it.each([
    ['core.manual', {}],
    ['core.webhook', { webhook: true }],
    ['core.schedule', { schedule: true }],
  ] as const)(
    'passes accepted run input to a %s trigger root',
    async (key, catalogOptions) => {
      const triggerGraph = structuredClone(graph());
      const trigger = triggerGraph.nodes[0];
      Object.assign(trigger, { definition: { key, version: 1 } });
      const executable = buildWorkflowExecutable({
        graph: triggerGraph,
        catalog: composeExecutableCatalog(nodeCatalog(catalogOptions)),
      });
      const runInput = { accepted: true, source: key };

      await expect(
        executeNodeAttempt({
          runId: 'run-trigger',
          nodeRunId: 'node-run-trigger',
          attemptId: 'attempt-trigger',
          executable,
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          invocationKey: invocationKey({
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
            nodeId: 'manual',
          }),
          nodeId: 'manual',
          runInput,
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
      ).resolves.toMatchObject({ output: runInput });
    },
  );
  it('resolves isolated preview inputs through the production mapping path', async () => {
    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview-node',
          inputMappings: {
            expression: {
              expression: 'runInput.count * 2',
              kind: 'expression',
              language: 'jsonata',
            },
            fromRun: { kind: 'run_input', path: '$.name' },
            literal: { kind: 'literal', value: true },
            missing: { kind: 'run_input', path: '$.absent' },
          },
        },
        runInput: { count: 4, name: 'Ada' },
        expressionEvaluator,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ expression: 8, fromRun: 'Ada', literal: true });

    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview-node',
          inputMappings: {
            upstream: {
              kind: 'node_output',
              nodeId: 'another-node',
              path: '$.value',
            },
          },
        },
        runInput: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });
  it('resolves the tested earlier step’s output when a test uses it', async () => {
    const node = {
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'create-file',
      inputMappings: {
        data: { kind: 'node_output', nodeId: 'read-file', path: '$' },
        firstName: {
          kind: 'node_output',
          nodeId: 'read-file',
          path: '$.rows[0].name',
        },
        fromRun: { kind: 'run_input', path: '$.rows[0].name' },
      },
    };
    const priorOutput = { rows: [{ name: 'Ada' }] };

    await expect(
      resolveSingleNodePreviewInput({
        node,
        runInput: priorOutput,
        priorPreviewNodeId: 'read-file',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      data: priorOutput,
      firstName: 'Ada',
      fromRun: 'Ada',
    });
  });
  it('names the mapping that needs an earlier step’s tested output', async () => {
    const node = {
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'create-file',
      inputMappings: {
        name: { kind: 'literal', value: 'report.csv' },
        data: { kind: 'node_output', nodeId: 'read-file', path: '$' },
      },
    };
    for (const priorPreviewNodeId of [undefined, 'another-step'])
      await expect(
        resolveSingleNodePreviewInput({
          node,
          runInput: {},
          ...(priorPreviewNodeId === undefined ? {} : { priorPreviewNodeId }),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        code: 'attempt_invalid',
        mappingKey: 'data',
        sourceNodeId: 'read-file',
      });
  });
  it('classifies aggregate mapped-input overflow as an invalid attempt', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const repeatedGraph = structuredClone(graph());
    Object.assign(repeatedGraph.nodes[1], {
      inputMappings: {
        first: { kind: 'run_input', path: '$.large' },
        second: { kind: 'run_input', path: '$.large' },
      },
    });
    const executable = buildWorkflowExecutable({
      graph: repeatedGraph,
      catalog,
    });
    let executions = 0;
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { large: 'x'.repeat(600_000) },
        completedNodeOutputs: completedOutputs({ manual: {} }),
        registry: {
          execute: () => {
            executions += 1;
            return Promise.resolve({ kind: 'succeeded' as const, output: {} });
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'attempt_invalid',
      message: 'mapped input exceeds runtime limits',
    });
    expect(executions).toBe(0);
  });
  it('hands over the resolved input before the executor runs, even when it fails', async () => {
    const order: string[] = [];
    const recorded: unknown[] = [];
    const failing = {
      execute: () => {
        order.push('execute');
        return Promise.reject(
          new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'provider',
            possiblyDispatched: false,
          }),
        );
      },
    };
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable: mappedExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: failing,
        signal: new AbortController().signal,
        onInputResolved: (input) => {
          order.push('recorded');
          recorded.push(input);
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(NodeExecutorFailure);
    expect(order).toEqual(['recorded', 'execute']);
    expect(recorded).toEqual([
      { expression: 5, fromNode: 3, fromRun: 'Ada', literal: null },
    ]);
  });
});
