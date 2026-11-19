import { describe, expect, it } from 'vitest';
import type {
  NodeCallbackTarget,
  NodeExecutionRequest,
} from '@pertexo/node-sdk/server';
import { callbackMappingExpression } from '@pertexo/workflow-model';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/server.js';
import {
  completedOutputs,
  graph,
  nodeCatalog,
} from '../../support/executable-workflow.js';
import { expressionEvaluator } from '../../support/compilation/input-resolution.js';

const VERSION_ID = '00000000-0000-4000-8000-000000000001';

function callbackWait(
  id: string,
  config: Readonly<Record<string, unknown>>,
  x: number,
) {
  return {
    id,
    definition: { key: 'core.wait', version: 1 },
    position: { x, y: 0 },
    configVersion: 1,
    config: { mode: 'callback', ...config },
    inputMappings: {},
    connectionRefs: {},
  };
}

/** manual -> send -> wait-later -> wait-earlier; send hands both Waits' callbacks to a partner. */
function sendingWorkflow() {
  return buildWorkflowExecutable({
    graph: {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        {
          id: 'manual',
          definition: { key: 'core.manual', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
        {
          id: 'send',
          definition: { key: 'test.http', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {
            orderId: { kind: 'literal', value: 'order-7' },
            approvedUrl: {
              kind: 'expression',
              language: 'jsonata',
              expression: callbackMappingExpression('wait-later', 'url'),
            },
            shippedUrl: {
              kind: 'expression',
              language: 'jsonata',
              expression: callbackMappingExpression('wait-earlier', 'url'),
            },
            shippedSecret: {
              kind: 'expression',
              language: 'jsonata',
              expression: callbackMappingExpression('wait-earlier', 'secret'),
            },
          },
          connectionRefs: {},
        },
        callbackWait('wait-later', { timeoutSeconds: 3_600 }, 20),
        callbackWait(
          'wait-earlier',
          {
            timeoutSeconds: 60,
            authentication: {
              mode: 'header_secret',
              headerName: 'x-partner-secret',
              allowedOrigins: ['https://partner.example'],
            },
          },
          30,
        ),
      ],
      edges: [
        {
          id: 'manual-send',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'send', port: 'in' },
        },
        {
          id: 'send-wait-later',
          source: { nodeId: 'send', port: 'out' },
          target: { nodeId: 'wait-later', port: 'in' },
        },
        {
          id: 'wait-later-wait-earlier',
          source: { nodeId: 'wait-later', port: 'out' },
          target: { nodeId: 'wait-earlier', port: 'in' },
        },
      ],
    },
    catalog: composeExecutableCatalog(nodeCatalog({ wait: true, http: true })),
  });
}

function attempt(
  runtime: Parameters<typeof executeNodeAttempt>[0]['runtime'],
  sent: NodeExecutionRequest[] = [],
) {
  return executeNodeAttempt({
    runId: 'run-callbacks',
    nodeRunId: 'node-run-send',
    attemptId: 'attempt-send',
    executable: sendingWorkflow(),
    workflowVersionId: VERSION_ID,
    invocationKey: invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'send',
    }),
    nodeId: 'send',
    runInput: {},
    completedNodeOutputs: completedOutputs({ manual: {} }),
    expressionEvaluator,
    signal: new AbortController().signal,
    ...(runtime === undefined ? {} : { runtime }),
    registry: {
      execute: (request) => {
        sent.push(request);
        return Promise.resolve({ kind: 'succeeded', output: {} });
      },
    },
  });
}

const runtimeBase = {
  workspaceId: '00000000-0000-4000-8000-000000000099',
  runId: 'run-callbacks',
  nodeRunId: 'node-run-send',
  attemptId: 'attempt-send',
  attemptNumber: 1,
  nodeId: 'send',
  invocationKey: 'send-key',
  sideEffectClass: 'safe',
  beforeDispatch: () => Promise.resolve(),
} as const;

describe('callback URLs a sending step hands to a partner', () => {
  it('issues one callback per referenced Wait, with that Wait’s timeout and authentication', async () => {
    const prepared: (readonly NodeCallbackTarget[])[] = [];
    const sent: NodeExecutionRequest[] = [];
    await attempt(
      {
        ...runtimeBase,
        callbacks: {
          prepare: ({ targets, signal }) => {
            expect(signal.aborted).toBe(false);
            prepared.push(targets);
            return Promise.resolve(
              Object.fromEntries(
                targets.map(({ nodeId }) => [
                  nodeId,
                  {
                    url: `https://hooks.example/${nodeId}`,
                    secret: `secret-for-${nodeId}`,
                  },
                ]),
              ),
            );
          },
          sensitiveValues: () => [],
        },
      },
      sent,
    );

    expect(prepared).toEqual([
      [
        {
          nodeId: 'wait-earlier',
          timeoutSeconds: 60,
          authentication: {
            mode: 'header_secret',
            headerName: 'x-partner-secret',
            allowedOrigins: ['https://partner.example'],
          },
        },
        {
          nodeId: 'wait-later',
          timeoutSeconds: 3_600,
          authentication: { mode: 'secret_url', allowedOrigins: [] },
        },
      ],
    ]);
    expect(sent.map(({ input }) => input)).toEqual([
      {
        orderId: 'order-7',
        approvedUrl: 'https://hooks.example/wait-later',
        shippedUrl: 'https://hooks.example/wait-earlier',
        shippedSecret: 'secret-for-wait-earlier',
      },
    ]);
  });

  it.each([
    ['a single-step preview with no runtime', undefined],
    ['a run without callback keys', runtimeBase],
  ])(
    'refuses the step before it sends anything in %s',
    async (_case, runtime) => {
      const sent: NodeExecutionRequest[] = [];
      await expect(attempt(runtime, sent)).rejects.toMatchObject({
        code: 'attempt_invalid',
        message:
          'Callback URLs are unavailable. Configure callback keys and use Test workflow or a real run; single-step previews do not issue them.',
      });
      expect(sent).toEqual([]);
    },
  );

  it('fails a step whose expression cannot be parsed as a failure of that mapping', async () => {
    const draft = structuredClone(graph());
    Object.assign(draft.nodes[1], {
      inputMappings: {
        broken: { kind: 'expression', language: 'jsonata', expression: '1 +' },
      },
    });
    const sent: NodeExecutionRequest[] = [];
    await expect(
      executeNodeAttempt({
        runId: 'run-broken',
        nodeRunId: 'node-run-broken',
        attemptId: 'attempt-broken',
        executable: buildWorkflowExecutable({
          graph: draft,
          catalog: composeExecutableCatalog(nodeCatalog()),
        }),
        workflowVersionId: VERSION_ID,
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: {},
        completedNodeOutputs: completedOutputs({ manual: {} }),
        expressionEvaluator,
        signal: new AbortController().signal,
        registry: {
          execute: (request) => {
            sent.push(request);
            return Promise.resolve({ kind: 'succeeded', output: {} });
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'expression_failed',
      diagnostic: { mappingKey: 'broken', sourceKind: 'expression' },
    });
    expect(sent).toEqual([]);
  });
});
