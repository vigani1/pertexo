import { describe, expect, it, vi } from 'vitest';
import {
  boundedNodeJsonRecordSchema,
  NODE_JSON_LIMITS_V1,
} from '@pertexo/node-sdk';
import type { NodeExecutionInvocation } from '@pertexo/node-sdk/server';

import {
  CORE_WORKFLOW_CALL_CONFIG_SCHEMA,
  CORE_WORKFLOW_CALL_DEFINITION,
  CORE_WORKFLOW_CALL_EXECUTOR,
  CORE_WORKFLOW_CALL_INPUT_SCHEMA,
  CORE_WORKFLOW_CALL_MANIFEST,
  CORE_WORKFLOW_CALL_OUTPUT_SCHEMA,
  CORE_WORKFLOW_CALL_POLICY,
} from '../src/workflow-call/index.js';
import { coreWorkflowCallExecutor } from '../src/workflow-call/executor.js';
import { CORE_BOUNDED_JSON_POLICY } from '../src/policies.js';

const config = {
  workflowId: '10000000-0000-4000-8000-000000000001',
  versionId: '10000000-0000-4000-8000-000000000002',
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
};
const invocation = (
  input: unknown,
): NodeExecutionInvocation<unknown, unknown> => ({
  config,
  input,
  connectionRefs: {},
  signal: new AbortController().signal,
});

describe('Call Workflow declaration', () => {
  it('pins a strict immutable version and callable identity', () => {
    expect(CORE_WORKFLOW_CALL_CONFIG_SCHEMA.parse(config)).toEqual(config);
    expect(CORE_WORKFLOW_CALL_MANIFEST).toMatchObject({
      definition: CORE_WORKFLOW_CALL_DEFINITION,
      executor: CORE_WORKFLOW_CALL_EXECUTOR,
      configVersion: 1,
      executorAbi: 1,
      family: 'logic',
      retryClass: 'unsafe',
      resourceClass: 'cpu',
      ports: { inputs: ['in'], outputs: ['out'] },
      credentialRequirements: [],
      connectionRequirements: [],
      capabilities: [],
      policyReferences: [CORE_BOUNDED_JSON_POLICY, CORE_WORKFLOW_CALL_POLICY],
    });
    expect(coreWorkflowCallExecutor.policyReferences).toEqual(
      CORE_WORKFLOW_CALL_MANIFEST.policyReferences,
    );
  });

  it.each([
    { ...config, workflowId: 'not-a-uuid' },
    { ...config, versionId: 'not-a-uuid' },
    { ...config, checksum: `wf:v2:sha256:${'a'.repeat(64)}` },
    { ...config, checksum: `wf:v3:sha256:${'A'.repeat(64)}` },
    { ...config, checksum: `wf:v3:sha256:${'a'.repeat(63)}` },
    {
      ...config,
      callableContractIdentity: `callable:v2:sha256:${'b'.repeat(64)}`,
    },
    {
      ...config,
      callableContractIdentity: `callable:v1:sha256:${'B'.repeat(64)}`,
    },
    {
      ...config,
      callableContractIdentity: `callable:v1:sha256:${'b'.repeat(65)}`,
    },
    { ...config, extra: true },
    { workflowId: config.workflowId },
  ])('rejects invalid pins or extra config %#', (candidate) => {
    expect(CORE_WORKFLOW_CALL_CONFIG_SCHEMA.safeParse(candidate).success).toBe(
      false,
    );
  });

  it('uses the existing bounded JSON record owner for both declaration projections', () => {
    expect(CORE_WORKFLOW_CALL_INPUT_SCHEMA).toBe(boundedNodeJsonRecordSchema);
    expect(CORE_WORKFLOW_CALL_OUTPUT_SCHEMA).toBe(boundedNodeJsonRecordSchema);
    expect(
      CORE_WORKFLOW_CALL_INPUT_SCHEMA.parse({
        arbitrary: [1, null, { valid: true }],
      }),
    ).toEqual({ arbitrary: [1, null, { valid: true }] });
    expect(CORE_WORKFLOW_CALL_MANIFEST.inputSchema).toHaveProperty(
      'x-pertexo-node-json-limits',
      NODE_JSON_LIMITS_V1,
    );
  });

  it.each([null, [], 'input', { invalid: Number.NaN }, { invalid: undefined }])(
    'rejects non-object or non-JSON input %#',
    (input) => {
      expect(CORE_WORKFLOW_CALL_INPUT_SCHEMA.safeParse(input).success).toBe(
        false,
      );
      expect(CORE_WORKFLOW_CALL_OUTPUT_SCHEMA.safeParse(input).success).toBe(
        false,
      );
    },
  );

  it('rejects byte, depth, member, cycle and accessor violations safely', () => {
    let deep: unknown = null;
    for (let index = 0; index < NODE_JSON_LIMITS_V1.depth + 1; index += 1)
      deep = { child: deep };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = vi.fn(() => {
      throw new Error('must not read');
    });
    const getter = Object.defineProperty({}, 'value', {
      get: accessor,
      enumerable: true,
    });
    for (const input of [
      { text: 'x'.repeat(NODE_JSON_LIMITS_V1.bytes) },
      { deep },
      {
        members: Array.from(
          { length: NODE_JSON_LIMITS_V1.members + 1 },
          () => null,
        ),
      },
      cycle,
      getter,
    ]) {
      expect(CORE_WORKFLOW_CALL_INPUT_SCHEMA.safeParse(input).success).toBe(
        false,
      );
      expect(CORE_WORKFLOW_CALL_OUTPUT_SCHEMA.safeParse(input).success).toBe(
        false,
      );
    }
    expect(accessor).not.toHaveBeenCalled();
  });

  it('returns only an independent frozen declaration without runtime I/O', async () => {
    const input = { order: { id: 'order-1' } };
    const beforeDispatch = vi.fn();
    const output: unknown = await coreWorkflowCallExecutor.execute({
      ...invocation(input),
      runtime: {
        workspaceId: 'workspace',
        runId: 'run',
        nodeRunId: 'node-run',
        attemptId: 'attempt',
        attemptNumber: 1,
        nodeId: 'call',
        invocationKey: 'call',
        sideEffectClass: 'unsafe',
        beforeDispatch,
      },
    });
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output)).toBe(true);
    input.order.id = 'changed';
    expect(output).toEqual({ order: { id: 'order-1' } });
    expect(beforeDispatch).not.toHaveBeenCalled();
  });

  it('validates config and bounded input even when the executor is invoked directly', () => {
    expect(() =>
      coreWorkflowCallExecutor.execute({ ...invocation({}), config: {} }),
    ).toThrow();
    expect(() => coreWorkflowCallExecutor.execute(invocation([]))).toThrow();
  });
});
